import { describe, expect, it } from 'vitest';
import {
  decideReconcile,
  isPendingSuperseded,
  isUniquifiedLocalName,
  rebindIndexNamesByIdentity,
  recoverInFlightOperations,
  replacePendingForId,
  type PendingOperation,
  type ReconcileInput,
  type RemoteFileRecord,
  type VaultIndex,
  type VaultIndexEntry,
} from '@yard-1/vault';

const id = '-NabcDEFGHIJKLMNOP12';
const revisionA = '550e8400-e29b-41d4-a716-446655440000';
const revisionB = '550e8400-e29b-41d4-a716-446655440001';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function record(overrides: Partial<RemoteFileRecord> = {}): RemoteFileRecord {
  return {
    schemaVersion: 1,
    name: 'note.txt',
    createdAt: 10,
    updatedAt: 20,
    size: 4,
    mimeType: 'text/plain',
    sha256: hashA,
    revision: revisionA,
    content: { kind: 'inline', text: 'note', encoding: 'utf-8' },
    ...overrides,
  };
}

function entry(overrides: Partial<VaultIndexEntry> = {}): VaultIndexEntry {
  return {
    id,
    localName: 'note.txt',
    appliedRemote: {
      revision: revisionA,
      updatedAt: 20,
      sha256: hashA,
      size: 4,
      preferredName: 'note.txt',
    },
    ...overrides,
  };
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    id,
    local: { name: 'note.txt', size: 4, mtimeMs: 20 },
    localSha256: hashA,
    indexEntry: entry(),
    pending: null,
    remoteRecord: record(),
    remoteLegacy: false,
    remoteInvalidReason: null,
    tombstone: null,
    appliedTombstone: null,
    occupiedNames: ['note.txt'],
    outwardEnabled: true,
    connected: true,
    remoteCatalogReady: true,
    landedThisGeneration: true,
    ...overrides,
  };
}

describe('isUniquifiedLocalName', () => {
  it('detects stem.N.ext suffixes without treating the preferred name as uniquified', () => {
    expect(isUniquifiedLocalName('Report.pdf', 'Report.pdf')).toBe(false);
    expect(isUniquifiedLocalName('Report.2.pdf', 'Report.pdf')).toBe(true);
    expect(isUniquifiedLocalName('Notes.pdf', 'Report.pdf')).toBe(false);
  });
});

describe('pending journal helpers', () => {
  it('recovers in-flight operations and replaces older ops for the same id', () => {
    const queued: PendingOperation = {
      kind: 'update',
      opId: 'op-1',
      id,
      revision: revisionA,
      queuedAt: 1,
      state: 'in-flight',
      expected: { updatedAt: 20, revision: revisionA },
      localName: 'note.txt',
    };
    const recovered = recoverInFlightOperations([queued]);
    expect(recovered[0]?.state).toBe('queued');

    const next: PendingOperation = { ...queued, opId: 'op-2', queuedAt: 2, state: 'queued' };
    expect(replacePendingForId(recovered, next)).toEqual([next]);
  });

  it('supersedes queued updates when remote clock is newer', () => {
    const pending: PendingOperation = {
      kind: 'update',
      opId: 'op-1',
      id,
      revision: revisionB,
      queuedAt: 1,
      state: 'queued',
      expected: { updatedAt: 20, revision: revisionA },
      localName: 'note.txt',
    };
    expect(isPendingSuperseded(pending, { updatedAt: 30, revision: revisionB })).toBe(true);
    expect(isPendingSuperseded(pending, { updatedAt: 20, revision: revisionA })).toBe(false);
  });
});

describe('decideReconcile', () => {
  it('is a noop when applied remote and local hash already match', () => {
    expect(decideReconcile(input()).type).toBe('noop');
  });

  it('migrates legacy records and isolates invalid remotes', () => {
    expect(decideReconcile(input({ remoteLegacy: true, remoteRecord: null })).type).toBe(
      'migrate-legacy',
    );
    const invalid = decideReconcile(
      input({
        remoteRecord: null,
        remoteInvalidReason: 'Remote file record is missing required fields.',
      }),
    );
    expect(invalid).toEqual({
      type: 'ignore-invalid',
      reason: 'Remote file record is missing required fields.',
    });
  });

  it('materializes a remote create onto an empty device', () => {
    const decision = decideReconcile(
      input({
        local: null,
        localSha256: null,
        indexEntry: null,
        outwardEnabled: false,
        occupiedNames: [],
      }),
    );
    expect(decision.type).toBe('materialize-remote');
    if (decision.type === 'materialize-remote') {
      expect(decision.targetName).toBe('note.txt');
    }
  });

  it('queues a local content update when hashes diverge at the same remote clock', () => {
    expect(decideReconcile(input({ localSha256: hashB })).type).toBe('queue-update');
  });

  it('lets a newer remote revision win over a stale pending local update', () => {
    const pending: PendingOperation = {
      kind: 'update',
      opId: 'op-1',
      id,
      revision: revisionA,
      queuedAt: 1,
      state: 'queued',
      expected: { updatedAt: 20, revision: revisionA },
      localName: 'note.txt',
    };
    const remote = record({
      updatedAt: 40,
      revision: revisionB,
      sha256: hashB,
      content: { kind: 'inline', text: 'next', encoding: 'utf-8' },
      size: 4,
    });
    const decision = decideReconcile(
      input({
        pending,
        remoteRecord: remote,
        localSha256: hashA,
      }),
    );
    expect(decision.type).toBe('materialize-remote');
  });

  it('applies a winning tombstone over a pending create instead of republishing', () => {
    const pending: PendingOperation = {
      kind: 'create',
      opId: 'op-create',
      id,
      revision: revisionA,
      queuedAt: 1,
      state: 'queued',
      localName: 'note.txt',
      preferredName: 'note.txt',
    };
    expect(
      decideReconcile(
        input({
          pending,
          remoteRecord: null,
          tombstone: { deletedAt: 50, revision: revisionB },
          indexEntry: { id, localName: 'note.txt' },
        }),
      ).type,
    ).toBe('apply-tombstone');
  });

  it('applies a winning tombstone over a stale offline update', () => {
    const pending: PendingOperation = {
      kind: 'update',
      opId: 'op-1',
      id,
      revision: revisionB,
      queuedAt: 1,
      state: 'queued',
      expected: { updatedAt: 20, revision: revisionA },
      localName: 'note.txt',
    };
    expect(
      decideReconcile(
        input({
          pending,
          remoteRecord: null,
          tombstone: { deletedAt: 50, revision: revisionB },
        }),
      ).type,
    ).toBe('apply-tombstone');
  });

  it('renames locally when only the preferred name changed', () => {
    const remote = record({ name: 'renamed.txt' });
    const decision = decideReconcile(
      input({
        remoteRecord: remote,
        occupiedNames: ['note.txt'],
      }),
    );
    expect(decision.type).toBe('rename-local');
    if (decision.type === 'rename-local') {
      expect(decision.targetName).toBe('renamed.txt');
    }
  });

  it('queues a local delete after bootstrap when a mapped file is missing', () => {
    expect(
      decideReconcile(
        input({
          local: null,
          localSha256: null,
          outwardEnabled: true,
          landedThisGeneration: true,
        }),
      ).type,
    ).toBe('queue-delete');
  });

  it('rematerializes a never-landed indexed remote instead of queue-deleting', () => {
    expect(
      decideReconcile(
        input({
          local: null,
          localSha256: null,
          outwardEnabled: true,
          landedThisGeneration: false,
          occupiedNames: [],
        }),
      ).type,
    ).toBe('materialize-remote');
  });

  it('does not delete-from-absence a never-landed id when the remote is also gone', () => {
    expect(
      decideReconcile(
        input({
          local: null,
          localSha256: null,
          remoteRecord: null,
          tombstone: null,
          outwardEnabled: true,
          landedThisGeneration: false,
        }),
      ).type,
    ).toBe('noop');
  });

  it('does not treat device uniquify suffixes as a preferred-name rename', () => {
    expect(
      decideReconcile(
        input({
          local: { name: 'note.2.txt', size: 4, mtimeMs: 20 },
          indexEntry: entry({ localName: 'note.2.txt' }),
          remoteRecord: null,
          occupiedNames: ['note.txt', 'note.2.txt'],
        }),
      ).type,
    ).toBe('noop');
  });

  it('acks a pending create whose revision is already on the remote record', () => {
    const pending: PendingOperation = {
      kind: 'create',
      opId: 'op-1',
      id,
      revision: revisionA,
      queuedAt: 1,
      state: 'in-flight',
      localName: 'note.txt',
      preferredName: 'note.txt',
    };
    const decision = decideReconcile(input({ pending }));
    expect(decision.type).toBe('ack-pending');
  });

  it('materializes a remote blob when inline content grows past the threshold', () => {
    const remote = record({
      updatedAt: 50,
      revision: revisionB,
      sha256: hashB,
      size: 20_000,
      content: { kind: 'blob', storagePath: `vault/u/${id}/${revisionB}` },
    });
    expect(
      decideReconcile(
        input({
          remoteRecord: remote,
          localSha256: hashA,
          indexEntry: entry({
            appliedRemote: {
              revision: revisionA,
              updatedAt: 20,
              sha256: hashA,
              size: 4,
              preferredName: 'note.txt',
            },
          }),
        }),
      ).type,
    ).toBe('materialize-remote');
  });

  it('uniquifies preferred rename when the target name is occupied locally', () => {
    const remote = record({ name: 'Report.pdf', updatedAt: 30, revision: revisionB });
    const decision = decideReconcile(
      input({
        remoteRecord: remote,
        local: { name: 'note.txt', size: 4, mtimeMs: 20 },
        occupiedNames: ['note.txt', 'Report.pdf'],
      }),
    );
    expect(decision.type).toBe('rename-local');
    if (decision.type === 'rename-local') {
      expect(decision.targetName).toBe('Report.2.pdf');
    }
  });

  it('queues a local rename when the disk name diverges from the preferred name', () => {
    expect(
      decideReconcile(
        input({
          remoteRecord: null,
          tombstone: null,
          local: { name: 'renamed.txt', size: 4, mtimeMs: 25 },
          indexEntry: entry({ localName: 'renamed.txt' }),
        }),
      ).type,
    ).toBe('queue-rename');
  });

  it('rejects resurrection when an applied tombstone is newer than the live record', () => {
    expect(
      decideReconcile(
        input({
          remoteRecord: record({ updatedAt: 10, revision: revisionA }),
          tombstone: null,
          appliedTombstone: { deletedAt: 50, revision: revisionB },
        }),
      ).type,
    ).toBe('reject-resurrection');
  });

  it('holds pending work offline and publishes when connected', () => {
    const pending: PendingOperation = {
      kind: 'update',
      opId: 'op-offline',
      id,
      revision: revisionB,
      queuedAt: 1,
      state: 'queued',
      expected: { updatedAt: 20, revision: revisionA },
      localName: 'note.txt',
    };
    expect(decideReconcile(input({ pending, connected: false })).type).toBe('noop');
    expect(decideReconcile(input({ pending, connected: true })).type).toBe('publish-pending');
  });

  it('does not tombstone missing locals or publish while the remote catalog is unlisted', () => {
    expect(
      decideReconcile(
        input({
          local: null,
          localSha256: null,
          remoteRecord: null,
          tombstone: null,
          remoteCatalogReady: false,
          connected: false,
        }),
      ).type,
    ).toBe('noop');

    expect(
      decideReconcile(
        input({
          remoteRecord: null,
          tombstone: null,
          remoteCatalogReady: false,
          connected: true,
        }),
      ).type,
    ).toBe('noop');

    const pending: PendingOperation = {
      kind: 'update',
      opId: 'op-hold',
      id,
      revision: revisionB,
      queuedAt: 1,
      state: 'queued',
      expected: { updatedAt: 20, revision: revisionA },
      localName: 'note.txt',
    };
    expect(
      decideReconcile(input({ pending, connected: true, remoteCatalogReady: false })).type,
    ).toBe('noop');
  });

  it('queues a cloud delete when a mapped file is gone after the catalog is known', () => {
    expect(
      decideReconcile(
        input({
          local: null,
          localSha256: null,
          remoteRecord: null,
          tombstone: null,
          remoteCatalogReady: true,
          outwardEnabled: true,
          landedThisGeneration: true,
        }),
      ).type,
    ).toBe('queue-delete');
  });

  it('does not treat a missing mapped file as a delete before outward sync is enabled', () => {
    expect(
      decideReconcile(
        input({
          local: null,
          localSha256: null,
          remoteRecord: null,
          tombstone: null,
          remoteCatalogReady: true,
          outwardEnabled: false,
        }),
      ).type,
    ).toBe('noop');
  });

  it('rebinds index local names after an offline Finder rename by file identity', () => {
    const index: VaultIndex = {
      schemaVersion: 1,
      ownerUid: 'uid',
      entries: {
        [id]: {
          id,
          localName: 'old.txt',
          identity: { dev: '1', ino: '42' },
        },
      },
      pendingOperations: [],
      appliedTombstones: {},
    };
    const rebound = rebindIndexNamesByIdentity(index, [
      { name: 'new.txt', size: 4, mtimeMs: 1, identity: { dev: '1', ino: '42' } },
    ]);
    expect(rebound.entries[id]?.localName).toBe('new.txt');
  });
});
