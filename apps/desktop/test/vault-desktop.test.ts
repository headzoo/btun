import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VAULT_INDEX_FILENAME, createEmptyVaultIndex, parseVaultIndexText } from '@yard-1/vault';
import { ensureOwnerIndex, writeVaultIndexAtomic } from '../electron/main/vault-index-io';
import {
  canonicalizePath,
  isPathInsideRoot,
  resolveDefaultVaultRoot,
  resolveVaultChildPath,
  validateDirectChildName,
} from '../electron/main/vault-paths';
import {
  diffVaultSnapshots,
  filterExpectedEffects,
  fingerprintKey,
  type ScannedChild,
} from '../electron/main/vault-scan';
import { loadVaultSettings, saveVaultSettings } from '../electron/main/vault-settings';
import { VaultService, type VaultServiceHost } from '../electron/main/vault-service';

function makeChild(
  name: string,
  opts: Partial<ScannedChild> & { size?: number; mtimeMs?: number } = {},
): ScannedChild {
  const size = opts.size ?? 10;
  const mtimeMs = opts.mtimeMs ?? 1000;
  return {
    name,
    size,
    mtimeMs,
    identity: opts.identity,
    fingerprintKey: opts.fingerprintKey ?? fingerprintKey({ size, mtimeMs }),
  };
}

describe('vault path containment', () => {
  it('defaults to Documents/Buddy Tunnel with home fallback', () => {
    expect(resolveDefaultVaultRoot('/docs', '/home/user')).toBe(path.join('/docs', 'Buddy Tunnel'));
    expect(resolveDefaultVaultRoot('', '/home/user')).toBe(path.join('/home/user', 'Buddy Tunnel'));
  });

  it('rejects unsafe names and path escapes', () => {
    expect(validateDirectChildName('../x').ok).toBe(false);
    expect(validateDirectChildName('.buddy-tunnel.json').ok).toBe(false);
    expect(validateDirectChildName('ok.txt').ok).toBe(true);

    const root = canonicalizePath('/tmp/vault-root');
    expect(resolveVaultChildPath(root, 'note.txt').ok).toBe(true);
    expect(resolveVaultChildPath(root, '../note.txt').ok).toBe(false);
    expect(isPathInsideRoot(root, path.join(root, 'note.txt'))).toBe(true);
    expect(isPathInsideRoot(root, path.join(root, '..', 'outside.txt'))).toBe(false);
  });
});

describe('vault snapshot diff and expected effects', () => {
  it('pairs renames by identity then unique fingerprint', () => {
    const previous = new Map<string, ScannedChild>([
      ['a.txt', makeChild('a.txt', { identity: { dev: '1', ino: '10' }, size: 4, mtimeMs: 50 })],
      ['b.txt', makeChild('b.txt', { identity: { dev: '1', ino: '11' }, size: 8, mtimeMs: 60 })],
    ]);
    const next = new Map<string, ScannedChild>([
      [
        'a-renamed.txt',
        makeChild('a-renamed.txt', { identity: { dev: '1', ino: '10' }, size: 4, mtimeMs: 50 }),
      ],
      ['b.txt', makeChild('b.txt', { identity: { dev: '1', ino: '11' }, size: 8, mtimeMs: 60 })],
    ]);
    expect(diffVaultSnapshots(previous, next)).toEqual([
      { type: 'renamed', from: 'a.txt', to: 'a-renamed.txt' },
    ]);

    const prevFp = new Map<string, ScannedChild>([
      ['old.bin', makeChild('old.bin', { size: 20, mtimeMs: 9 })],
    ]);
    const nextFp = new Map<string, ScannedChild>([
      ['new.bin', makeChild('new.bin', { size: 20, mtimeMs: 9 })],
    ]);
    expect(diffVaultSnapshots(prevFp, nextFp)).toEqual([
      { type: 'renamed', from: 'old.bin', to: 'new.bin' },
    ]);
  });

  it('suppresses matching expected effects without swallowing unrelated edits', () => {
    const next = new Map<string, ScannedChild>([
      ['cloud.txt', makeChild('cloud.txt', { size: 3, mtimeMs: 1 })],
      ['user.txt', makeChild('user.txt', { size: 5, mtimeMs: 2 })],
    ]);
    const events = [
      { type: 'created' as const, name: 'cloud.txt' },
      { type: 'changed' as const, name: 'user.txt' },
    ];
    const filtered = filterExpectedEffects(
      events,
      [
        {
          id: 'id1',
          kind: 'write',
          name: 'cloud.txt',
          size: 3,
          revision: '00000000-0000-4000-8000-000000000001',
        },
      ],
      next,
    );
    expect(filtered.events).toEqual([{ type: 'changed', name: 'user.txt' }]);
    expect(filtered.remaining).toEqual([]);
  });

  it('does not treat same size as enough when a sha256 was registered but not scanned', () => {
    const next = new Map<string, ScannedChild>([
      ['cloud.txt', makeChild('cloud.txt', { size: 4, mtimeMs: 9 })],
    ]);
    const filtered = filterExpectedEffects(
      [{ type: 'changed', name: 'cloud.txt' }],
      [
        {
          id: 'id1',
          kind: 'write',
          name: 'cloud.txt',
          size: 4,
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          revision: '00000000-0000-4000-8000-000000000099',
        },
      ],
      next,
    );
    expect(filtered.events).toEqual([{ type: 'changed', name: 'cloud.txt' }]);
    expect(filtered.remaining).toHaveLength(1);
  });
});

describe('vault settings and index persistence', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores selected root outside the vault under userData', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-settings-'));
    dirs.push(userData);
    const saved = saveVaultSettings(userData, { selectedRoot: path.join(userData, 'Custom') });
    expect(saved.ok).toBe(true);
    const loaded = loadVaultSettings(userData);
    expect(loaded.selectedRoot).toBe(path.resolve(path.join(userData, 'Custom')));
  });

  it('writes index atomically and refuses owner mismatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-index-'));
    dirs.push(root);
    const index = createEmptyVaultIndex('owner-a');
    const written = await writeVaultIndexAtomic(root, index);
    expect(written.ok).toBe(true);
    expect(fs.existsSync(path.join(root, VAULT_INDEX_FILENAME))).toBe(true);

    const mismatched = await ensureOwnerIndex(root, 'owner-b');
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error.code).toBe('owner-mismatch');
    }

    const text = fs.readFileSync(path.join(root, VAULT_INDEX_FILENAME), 'utf8');
    expect(parseVaultIndexText(text).status).toBe('ok');
  });
});

describe('VaultService filesystem adapter', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createHost(
    rootBase: string,
    options: { pickDirectory?: () => Promise<string | null> } = {},
  ): VaultServiceHost {
    return {
      userDataPath: path.join(rootBase, 'userData'),
      documentsPath: path.join(rootBase, 'Documents'),
      homePath: path.join(rootBase, 'Home'),
      async showOpenDirectoryDialog() {
        if (options.pickDirectory) {
          return options.pickDirectory();
        }
        return path.join(rootBase, 'Picked');
      },
      async openPath() {
        return '';
      },
      showItemInFolder() {},
      startDrag() {},
    };
  }

  it('creates default Buddy Tunnel root and lists only direct regular files', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-service-'));
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(base, 'userData'), { recursive: true });

    const service = new VaultService(createHost(base));
    const started = await service.start('uid-1');
    expect(started.ok).toBe(true);

    const defaultRoot = path.join(base, 'Documents', 'Buddy Tunnel');
    expect(fs.existsSync(defaultRoot)).toBe(true);
    expect(started.ok && started.value.rootPath).toBe(defaultRoot);

    fs.writeFileSync(path.join(defaultRoot, 'keep.txt'), 'hello');
    fs.mkdirSync(path.join(defaultRoot, 'subdir'));
    fs.writeFileSync(path.join(defaultRoot, 'subdir', 'nested.txt'), 'nope');
    fs.symlinkSync(path.join(defaultRoot, 'keep.txt'), path.join(defaultRoot, 'link.txt'));

    const children = await service.listDirectChildren();
    expect(children.map((child) => child.name)).toEqual(['keep.txt']);

    const listed = await service.listEntries();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]?.localName).toBe('keep.txt');
    }

    await service.stop();
  });

  it('supports atomic write, rename, delete, import, and expected-effect suppression', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-service-ops-'));
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(base, 'userData'), { recursive: true });

    const service = new VaultService(createHost(base));
    await service.start('uid-2');

    const events: string[] = [];
    service.subscribeLocalChanges((event) => {
      events.push(event.type);
    });

    const created = await service.writeAtomicResult('note.txt', new TextEncoder().encode('one'));
    expect(created.ok).toBe(true);

    const renamed = await service.renameResult('note.txt', 'note-2.txt');
    expect(renamed.ok).toBe(true);

    const source = path.join(base, 'external.txt');
    fs.writeFileSync(source, 'paste-me');
    const imported = await service.importPaths([source]);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.value[0]?.localName).toBe('external.txt');
    }

    service.registerExpectedEffect({
      id: 'file-1',
      kind: 'write',
      name: 'cloud.txt',
      size: 5,
      revision: '00000000-0000-4000-8000-000000000099',
    });
    const root = service.getStatus().rootPath!;
    fs.writeFileSync(path.join(root, 'cloud.txt'), 'cloud');
    await service.flushScanForTests();

    // Mutation-path consumption: leftover write effects must not survive writeAtomic.
    service.registerExpectedEffect({
      id: 'file-2',
      kind: 'write',
      name: 'atomic.txt',
      size: 3,
      sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      revision: '00000000-0000-4000-8000-000000000098',
    });
    events.length = 0;
    const atomic = await service.writeAtomicResult('atomic.txt', new TextEncoder().encode('xyz'));
    expect(atomic.ok).toBe(true);
    await service.flushScanForTests();
    expect(events).toEqual([]);

    const names = (await service.listDirectChildren()).map((child) => child.name).sort();
    expect(names).toEqual(['atomic.txt', 'cloud.txt', 'external.txt', 'note-2.txt']);

    const removed = await service.removeResult('note-2.txt');
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'note-2.txt'))).toBe(false);

    await service.stop();
  });

  it('does not persist index on Finder rename so coordinator pending ops stay durable', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-finder-'));
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(base, 'userData'), { recursive: true });

    const service = new VaultService(createHost(base));
    await service.start('uid-finder');
    const root = service.getStatus().rootPath!;
    fs.writeFileSync(path.join(root, 'a.txt'), 'body');
    await service.flushScanForTests();

    const index = createEmptyVaultIndex('uid-finder');
    index.entries['id-1'] = {
      id: 'id-1',
      localName: 'a.txt',
      identity: { size: 4, mtimeMs: 1 },
    };
    index.pendingOperations = [
      {
        kind: 'update',
        opId: 'pending-1',
        id: 'id-1',
        revision: '00000000-0000-4000-8000-000000000077',
        queuedAt: Date.now(),
        state: 'queued',
        expected: {
          updatedAt: 1,
          revision: '00000000-0000-4000-8000-000000000066',
        },
        localName: 'a.txt',
      },
    ];
    const saved = await service.saveIndex(index);
    expect(saved.ok).toBe(true);

    fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    await service.flushScanForTests();

    const onDisk = parseVaultIndexText(
      fs.readFileSync(path.join(root, VAULT_INDEX_FILENAME), 'utf8'),
    );
    expect(onDisk.status).toBe('ok');
    if (onDisk.status === 'ok') {
      expect(onDisk.index.pendingOperations).toHaveLength(1);
      expect(onDisk.index.entries['id-1']?.localName).toBe('a.txt');
    }

    await service.stop();
  });

  it('does not silently ingest another uid index when switching owners', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-owner-'));
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'Documents'), { recursive: true });
    fs.mkdirSync(path.join(base, 'userData'), { recursive: true });

    const first = new VaultService(createHost(base));
    const started = await first.start('uid-a');
    expect(started.ok).toBe(true);
    const ownedRoot = started.ok ? started.value.rootPath : null;
    expect(ownedRoot).toBeTruthy();
    fs.writeFileSync(path.join(ownedRoot!, 'secret-a.txt'), 'owned-by-a');
    await first.stop();

    const second = new VaultService(createHost(base));
    const blocked = await second.start('uid-b');
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.value.uid).toBe('uid-b');
      expect(blocked.value.indexStatus).toBe('owner-mismatch');
      expect(blocked.value.indexOwnerUid).toBe('uid-a');
      expect(blocked.value.rootPath).toBe(ownedRoot);
    }

    const listed = await second.listEntries();
    expect(listed.ok).toBe(false);

    const children = await second.listDirectChildren();
    expect(children).toEqual([]);

    const saved = await second.saveIndex(createEmptyVaultIndex('uid-b'));
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.code).toBe('owner-mismatch');
    }

    // Original mismatched folder must remain untouched.
    const indexText = fs.readFileSync(path.join(ownedRoot!, VAULT_INDEX_FILENAME), 'utf8');
    const parsed = parseVaultIndexText(indexText);
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.index.ownerUid).toBe('uid-a');
    }
    expect(fs.existsSync(path.join(ownedRoot!, 'secret-a.txt'))).toBe(true);

    // Recovery: useDefaultRoot / configureRoot must work while uid is retained.
    const defaulted = await second.useDefaultRoot();
    // Default root is the same Documents/Buddy Tunnel path that mismatched — still blocked.
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.value.indexStatus).toBe('owner-mismatch');
      expect(defaulted.value.uid).toBe('uid-b');
    }

    const freshRoot = path.join(base, 'FreshVault');
    fs.mkdirSync(freshRoot, { recursive: true });
    const recovering = new VaultService(createHost(base, { pickDirectory: async () => freshRoot }));
    const rebound = await recovering.start('uid-b');
    expect(rebound.ok).toBe(true);
    expect(rebound.ok && rebound.value.indexStatus).toBe('owner-mismatch');
    expect(rebound.ok && rebound.value.uid).toBe('uid-b');

    const configured = await recovering.configureRoot();
    expect(configured.ok).toBe(true);
    if (configured.ok) {
      expect(configured.value.uid).toBe('uid-b');
      expect(configured.value.indexStatus).toBe('ok');
      expect(configured.value.rootPath).toBe(path.resolve(freshRoot));
      expect(configured.value.indexOwnerUid).toBe('uid-b');
    }

    const freshListed = await recovering.listEntries();
    expect(freshListed.ok).toBe(true);
    if (freshListed.ok) {
      expect(freshListed.value).toEqual([]);
    }

    // Original folder still belongs to uid-a.
    const stillOwned = parseVaultIndexText(
      fs.readFileSync(path.join(ownedRoot!, VAULT_INDEX_FILENAME), 'utf8'),
    );
    expect(stillOwned.status).toBe('ok');
    if (stillOwned.status === 'ok') {
      expect(stillOwned.index.ownerUid).toBe('uid-a');
    }

    await recovering.stop();
    await second.stop();
  });
});
