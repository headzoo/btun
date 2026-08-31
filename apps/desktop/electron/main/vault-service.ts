import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSafePathSegment,
  mimeTypeFromName,
  parseVaultIndex,
  sanitizePreferredName,
  uniquifyLocalName,
  vaultTempName,
  type DirectChildSnapshot,
  type ExpectedLocalEffect,
  type FileEntry,
  type LocalVaultEvent,
  type Unsubscribe,
  type VaultAdapter,
  type VaultIndex,
  type VaultIndexLoadResult,
  type VaultResult,
} from '@yard-1/vault';
import type { ImportedFileResult, VaultStatus } from './vault-api';
import { ensureOwnerIndex, loadVaultIndex, writeVaultIndexAtomic } from './vault-index-io';
import {
  diffVaultSnapshots,
  filterExpectedEffects,
  fingerprintKey,
  toPlatformIdentity,
  type ScannedChild,
} from './vault-scan';
import { loadVaultSettings, saveVaultSettings } from './vault-settings';
import {
  canonicalizePath,
  ensureDirectory,
  fail,
  forwardFail,
  isEligibleVaultFile,
  isIgnoredVaultChildName,
  isPathInsideRoot,
  lstatSafe,
  ok,
  resolveDefaultVaultRoot,
  resolveVaultChildPath,
  validateDirectChildName,
} from './vault-paths';
import { createDebouncedInvalidation, watchVaultRoot, type VaultWatcher } from './vault-watcher';

export interface VaultServiceHost {
  userDataPath: string;
  documentsPath: string;
  homePath: string;
  showOpenDirectoryDialog(): Promise<string | null>;
  openPath(target: string): Promise<string>;
  showItemInFolder(target: string): void;
  startDrag(payload: { file: string; icon?: string }): void;
}

const WATCH_DEBOUNCE_MS = 120;

function sha256FileSync(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class VaultService implements VaultAdapter {
  private readonly host: VaultServiceHost;
  private uid: string | null = null;
  private root: string | null = null;
  private usingDefaultRoot = true;
  private index: VaultIndex | null = null;
  private indexStatus: VaultIndexLoadResult['status'] | 'idle' = 'idle';
  private indexOwnerUid: string | undefined;
  private snapshot = new Map<string, ScannedChild>();
  private expectedEffects: ExpectedLocalEffect[] = [];
  private watcher: VaultWatcher | null = null;
  private readonly debounced: ReturnType<typeof createDebouncedInvalidation>;
  private readonly listeners = new Set<(event: LocalVaultEvent) => void>();
  private mutationDepth = 0;

  constructor(host: VaultServiceHost) {
    this.host = host;
    this.debounced = createDebouncedInvalidation(WATCH_DEBOUNCE_MS, async () => {
      if (!this.root || this.mutationDepth > 0) {
        return;
      }
      await this.rescanAndEmit();
    });
  }

  getStatus(): VaultStatus {
    return {
      running: this.uid !== null && this.root !== null,
      uid: this.uid,
      rootPath: this.root,
      rootDisplayName: this.root ? path.basename(this.root) : null,
      usingDefaultRoot: this.usingDefaultRoot,
      indexStatus: this.indexStatus,
      indexOwnerUid: this.indexOwnerUid,
    };
  }

  getDefaultRootPath(): string {
    return resolveDefaultVaultRoot(this.host.documentsPath, this.host.homePath);
  }

  async start(uid: string): Promise<VaultResult<VaultStatus>> {
    if (!isSafePathSegment(uid)) {
      return fail('unsafe-name', 'Invalid uid.');
    }
    await this.stopInternal();
    this.uid = uid;

    const settings = loadVaultSettings(this.host.userDataPath);
    const preferred =
      settings.selectedRoot && settings.selectedRoot.trim().length > 0
        ? canonicalizePath(settings.selectedRoot)
        : this.getDefaultRootPath();
    this.usingDefaultRoot = !settings.selectedRoot;

    const ready = await this.activateRoot(preferred, uid);
    if (!ready.ok) {
      // Keep authenticated uid so configureRoot / useDefaultRoot can recover.
      return forwardFail(ready);
    }
    return ok(this.getStatus());
  }

  async stop(): Promise<VaultResult<VaultStatus>> {
    await this.stopInternal();
    return ok(this.getStatus());
  }

  async configureRoot(): Promise<VaultResult<VaultStatus>> {
    if (!this.uid) {
      return fail('permission', 'Vault is not started.');
    }
    const selected = await this.host.showOpenDirectoryDialog();
    if (!selected) {
      return ok(this.getStatus());
    }
    const nextRoot = canonicalizePath(selected);
    const saved = saveVaultSettings(this.host.userDataPath, { selectedRoot: nextRoot });
    if (!saved.ok) {
      return forwardFail(saved);
    }
    this.usingDefaultRoot = false;
    const activated = await this.activateRoot(nextRoot, this.uid);
    if (!activated.ok) {
      return forwardFail(activated);
    }
    return ok(this.getStatus());
  }

  async useDefaultRoot(): Promise<VaultResult<VaultStatus>> {
    if (!this.uid) {
      return fail('permission', 'Vault is not started.');
    }
    const saved = saveVaultSettings(this.host.userDataPath, { selectedRoot: null });
    if (!saved.ok) {
      return forwardFail(saved);
    }
    this.usingDefaultRoot = true;
    const activated = await this.activateRoot(this.getDefaultRootPath(), this.uid);
    if (!activated.ok) {
      return forwardFail(activated);
    }
    return ok(this.getStatus());
  }

  async listEntries(): Promise<VaultResult<FileEntry[]>> {
    if (!this.root || !this.index || this.indexStatus === 'owner-mismatch') {
      return fail('permission', 'Vault is not started.');
    }
    await this.rescanQuiet();
    const byName = new Map<string, string>();
    for (const entry of Object.values(this.index.entries)) {
      byName.set(entry.localName, entry.id);
    }

    const entries: FileEntry[] = [];
    for (const child of this.snapshot.values()) {
      const id = byName.get(child.name);
      entries.push({
        id: id ?? `local:${child.name}`,
        localName: child.name,
        size: child.size,
        mtimeMs: child.mtimeMs,
        mimeType: mimeTypeFromName(child.name),
        status: id ? 'ready' : 'pending',
      });
    }
    entries.sort((a, b) => a.localName.localeCompare(b.localName));
    return ok(entries);
  }

  async listDirectChildren(): Promise<DirectChildSnapshot[]> {
    if (!this.root || !this.index || this.indexStatus === 'owner-mismatch') {
      return [];
    }
    const listed = await this.scanChildren();
    return [...listed.values()].map(({ fingerprintKey: _fp, ...rest }) => rest);
  }

  async loadIndex(): Promise<VaultResult<VaultIndexLoadResult>> {
    if (this.indexStatus === 'owner-mismatch') {
      return ok({
        status: 'owner-mismatch',
        ownerUid: this.indexOwnerUid ?? '',
        expectedUid: this.uid ?? '',
      });
    }
    if (!this.uid) {
      return fail('permission', 'Vault is not started.');
    }
    if (this.index) {
      return ok({ status: 'ok', index: this.index });
    }
    if (this.indexStatus === 'idle') {
      return ok({ status: 'missing' });
    }
    if (this.indexStatus === 'ok' || this.indexStatus === 'missing') {
      return ok({ status: 'missing' });
    }
    if (this.indexStatus === 'unsupported-version') {
      return ok({ status: 'unsupported-version', version: 0 });
    }
    return ok({ status: 'corrupt', error: 'Vault index is unavailable.' });
  }

  async saveIndex(index: VaultIndex): Promise<VaultResult<void>> {
    if (!this.uid || !this.root) {
      return fail('permission', 'Vault is not started.');
    }
    if (this.indexStatus === 'owner-mismatch') {
      return fail('owner-mismatch', 'Refusing to overwrite another account vault index.');
    }
    if (index.ownerUid !== this.uid) {
      return fail('owner-mismatch', 'Refusing to persist an index for a different owner.');
    }
    const parsed = parseVaultIndex(index);
    if (parsed.status !== 'ok') {
      return fail('io', parsed.status === 'corrupt' ? parsed.error : 'Invalid vault index.');
    }
    this.index = parsed.index;
    this.indexStatus = 'ok';
    this.indexOwnerUid = index.ownerUid;
    try {
      await this.persistIndex();
      return ok(undefined);
    } catch (error) {
      return fail('io', error instanceof Error ? error.message : 'Failed to persist vault index.');
    }
  }

  async readBytes(name: string): Promise<Uint8Array> {
    const resolved = this.requireChildPath(name);
    if (!resolved.ok) {
      throw new Error(resolved.error.message);
    }
    const stats = lstatSafe(resolved.value);
    if (!stats || !isEligibleVaultFile(stats)) {
      throw new Error('Not a regular vault file.');
    }
    return new Uint8Array(await fs.promises.readFile(resolved.value));
  }

  async readBytesResult(name: string): Promise<VaultResult<Uint8Array>> {
    try {
      return ok(await this.readBytes(name));
    } catch (error) {
      return fail('io', error instanceof Error ? error.message : 'Failed to read file.');
    }
  }

  async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    const result = await this.writeAtomicResult(name, bytes);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }

  async writeAtomicResult(
    name: string,
    bytes: Uint8Array,
  ): Promise<VaultResult<DirectChildSnapshot>> {
    return this.withMutation(async (): Promise<VaultResult<DirectChildSnapshot>> => {
      const resolved = this.requireChildPath(name);
      if (!resolved.ok) {
        return forwardFail(resolved);
      }
      const existed = this.snapshot.has(name);
      const written = await this.atomicWriteFile(resolved.value, bytes);
      if (!written.ok) {
        return forwardFail(written);
      }
      await this.rescanQuiet();
      const child = this.snapshot.get(name);
      if (!child) {
        return fail('io', 'Write succeeded but file was not visible in scan.');
      }
      this.consumeExpectedMutation({ type: existed ? 'changed' : 'created', name });
      return ok(this.toSnapshot(child));
    });
  }

  async materialize(
    localName: string,
    bytes: Uint8Array,
  ): Promise<VaultResult<DirectChildSnapshot>> {
    if (!this.root || !this.index || this.indexStatus === 'owner-mismatch') {
      return fail('permission', 'Vault is not started.');
    }
    const preferred = sanitizePreferredName(localName);
    const unique = uniquifyLocalName(preferred, [...this.snapshot.keys()], {
      caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin',
    });
    return this.writeAtomicResult(unique, bytes);
  }

  async rename(from: string, to: string): Promise<void> {
    const result = await this.renameResult(from, to);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }

  async renameResult(from: string, to: string): Promise<VaultResult<DirectChildSnapshot>> {
    return this.withMutation(async (): Promise<VaultResult<DirectChildSnapshot>> => {
      const fromPath = this.requireChildPath(from);
      if (!fromPath.ok) {
        return forwardFail(fromPath);
      }
      const toValidated = validateDirectChildName(to);
      if (!toValidated.ok) {
        return forwardFail(toValidated);
      }
      const toPath = this.requireChildPath(toValidated.value);
      if (!toPath.ok) {
        return forwardFail(toPath);
      }
      if (this.snapshot.has(toValidated.value)) {
        return fail('conflict', `A file named ${toValidated.value} already exists.`);
      }
      const stats = lstatSafe(fromPath.value);
      if (!stats || !isEligibleVaultFile(stats)) {
        return fail('not-found', `File not found: ${from}`);
      }
      try {
        await fs.promises.rename(fromPath.value, toPath.value);
      } catch (error) {
        return fail('io', error instanceof Error ? error.message : 'Rename failed.');
      }
      // Do not persist the index here — the coordinator is the sole durable writer.
      await this.rescanQuiet();
      const child = this.snapshot.get(toValidated.value);
      if (!child) {
        return fail('io', 'Rename succeeded but file was not visible in scan.');
      }
      this.consumeExpectedMutation({ type: 'renamed', from, to: toValidated.value });
      return ok(this.toSnapshot(child));
    });
  }

  async remove(name: string): Promise<void> {
    const result = await this.removeResult(name);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }

  async removeResult(name: string): Promise<VaultResult<void>> {
    return this.withMutation(async (): Promise<VaultResult<void>> => {
      const resolved = this.requireChildPath(name);
      if (!resolved.ok) {
        return forwardFail(resolved);
      }
      const stats = lstatSafe(resolved.value);
      if (!stats) {
        return fail('not-found', `File not found: ${name}`);
      }
      if (!isEligibleVaultFile(stats)) {
        return fail('not-a-file', `Not a regular vault file: ${name}`);
      }
      try {
        await fs.promises.unlink(resolved.value);
      } catch (error) {
        return fail('io', error instanceof Error ? error.message : 'Delete failed.');
      }
      await this.rescanQuiet();
      this.consumeExpectedMutation({ type: 'deleted', name });
      return ok(undefined);
    });
  }

  registerExpectedEffect(effect: ExpectedLocalEffect): void {
    this.expectedEffects.push(effect);
  }

  registerExpectedEffectResult(effect: ExpectedLocalEffect): VaultResult<void> {
    if (!effect.id || !effect.revision || !effect.kind) {
      return fail('unsafe-name', 'Invalid expected effect.');
    }
    this.registerExpectedEffect(effect);
    return ok(undefined);
  }

  subscribeLocalChanges(listener: (event: LocalVaultEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async importPaths(sourcePaths: string[]): Promise<VaultResult<ImportedFileResult[]>> {
    if (!this.root || !this.index || this.indexStatus === 'owner-mismatch') {
      return fail('permission', 'Vault is not started.');
    }
    return this.withMutation(async (): Promise<VaultResult<ImportedFileResult[]>> => {
      const imported: ImportedFileResult[] = [];
      const occupied = new Set(this.snapshot.keys());

      for (const raw of sourcePaths) {
        if (typeof raw !== 'string' || raw.trim().length === 0) {
          continue;
        }
        let source = raw;
        if (raw.startsWith('file:')) {
          try {
            source = fileURLToPath(raw);
          } catch {
            return fail('unsafe-name', `Invalid file URL: ${raw}`);
          }
        }
        source = canonicalizePath(source);
        if (
          this.root &&
          isPathInsideRoot(this.root, source) &&
          path.dirname(source) === this.root
        ) {
          return fail('conflict', 'Source path is already inside the vault.');
        }
        const stats = lstatSafe(source);
        if (!stats || !isEligibleVaultFile(stats)) {
          return fail('not-a-file', `Source is not a regular file: ${source}`);
        }
        const preferred = sanitizePreferredName(path.basename(source));
        const localName = uniquifyLocalName(preferred, occupied, {
          caseSensitive: process.platform !== 'win32' && process.platform !== 'darwin',
        });
        occupied.add(localName);
        const dest = this.requireChildPath(localName);
        if (!dest.ok) {
          return forwardFail(dest);
        }
        const bytes = await fs.promises.readFile(source);
        const written = await this.atomicWriteFile(dest.value, bytes);
        if (!written.ok) {
          return forwardFail(written);
        }
        imported.push({ sourcePath: source, localName, size: bytes.byteLength });
      }

      await this.rescanQuiet();
      return ok(imported);
    });
  }

  async openLocal(name: string): Promise<VaultResult<void>> {
    const resolved = this.requireChildPath(name);
    if (!resolved.ok) {
      return forwardFail(resolved);
    }
    const stats = lstatSafe(resolved.value);
    if (!stats || !isEligibleVaultFile(stats)) {
      return fail('not-found', `File not found: ${name}`);
    }
    const errorMessage = await this.host.openPath(resolved.value);
    if (errorMessage) {
      return fail('io', errorMessage);
    }
    return ok(undefined);
  }

  async revealLocal(name: string): Promise<VaultResult<void>> {
    const resolved = this.requireChildPath(name);
    if (!resolved.ok) {
      return forwardFail(resolved);
    }
    const stats = lstatSafe(resolved.value);
    if (!stats || !isEligibleVaultFile(stats)) {
      return fail('not-found', `File not found: ${name}`);
    }
    this.host.showItemInFolder(resolved.value);
    return ok(undefined);
  }

  async revealRoot(): Promise<VaultResult<void>> {
    if (!this.root) {
      return fail('permission', 'Vault is not started.');
    }
    const errorMessage = await this.host.openPath(this.root);
    if (errorMessage) {
      return fail('io', errorMessage);
    }
    return ok(undefined);
  }

  startDrag(name: string): VaultResult<void> {
    const resolved = this.requireChildPath(name);
    if (!resolved.ok) {
      return forwardFail(resolved);
    }
    const stats = lstatSafe(resolved.value);
    if (!stats || !isEligibleVaultFile(stats)) {
      return fail('not-found', `File not found: ${name}`);
    }
    try {
      this.host.startDrag({ file: resolved.value });
      return ok(undefined);
    } catch (error) {
      return fail('io', error instanceof Error ? error.message : 'Drag failed.');
    }
  }

  private async activateRoot(root: string, uid: string): Promise<VaultResult<void>> {
    this.teardownWatcher();
    this.snapshot.clear();
    this.expectedEffects = [];
    this.index = null;
    this.indexOwnerUid = undefined;

    const ensured = await ensureDirectory(root);
    if (!ensured.ok) {
      this.root = null;
      this.indexStatus = 'idle';
      return forwardFail(ensured);
    }
    this.root = ensured.value;

    // Probe ownership first so we can surface the real ownerUid without ingesting.
    const load = await loadVaultIndex(this.root, uid);
    if (load.status === 'owner-mismatch') {
      this.index = null;
      this.indexStatus = 'owner-mismatch';
      this.indexOwnerUid = load.ownerUid;
      // Keep root for status/display; do not watch, scan, or write an index.
      return ok(undefined);
    }

    const indexResult = await ensureOwnerIndex(this.root, uid);
    if (!indexResult.ok) {
      this.root = null;
      this.indexStatus = 'corrupt';
      this.indexOwnerUid = undefined;
      return forwardFail(indexResult);
    }
    this.index = indexResult.value.index;
    this.indexStatus = 'ok';
    this.indexOwnerUid = this.index.ownerUid;

    await this.rescanQuiet();
    this.startWatcher();
    return ok(undefined);
  }

  private async stopInternal(): Promise<void> {
    this.teardownWatcher();
    this.debounced.cancel();
    this.snapshot.clear();
    this.expectedEffects = [];
    this.index = null;
    this.root = null;
    this.uid = null;
    this.indexStatus = 'idle';
    this.indexOwnerUid = undefined;
    this.usingDefaultRoot = true;
  }

  private startWatcher(): void {
    if (!this.root) {
      return;
    }
    this.watcher = watchVaultRoot(this.root, () => {
      this.debounced.trigger();
    });
  }

  private teardownWatcher(): void {
    this.debounced.cancel();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private requireChildPath(name: string): VaultResult<string> {
    if (!this.root || !this.index || this.indexStatus === 'owner-mismatch') {
      return fail('permission', 'Vault is not started.');
    }
    return resolveVaultChildPath(this.root, name);
  }

  private toSnapshot(child: ScannedChild): DirectChildSnapshot {
    return {
      name: child.name,
      size: child.size,
      mtimeMs: child.mtimeMs,
      identity: child.identity,
    };
  }

  private async atomicWriteFile(targetPath: string, bytes: Uint8Array): Promise<VaultResult<void>> {
    if (!this.root) {
      return fail('permission', 'Vault is not started.');
    }
    const tempPath = path.join(this.root, vaultTempName(`write-${randomUUID()}`));
    try {
      await fs.promises.writeFile(tempPath, bytes);
      const fh = await fs.promises.open(tempPath, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tempPath, targetPath);
      return ok(undefined);
    } catch (error) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore
      }
      return fail('io', error instanceof Error ? error.message : 'Atomic write failed.');
    }
  }

  /** Exposed for unit tests to force watcher-equivalent rescans. */
  async flushScanForTests(): Promise<void> {
    await this.rescanAndEmit();
  }

  private async persistIndex(): Promise<void> {
    if (!this.root || !this.index) {
      return;
    }
    const written = await writeVaultIndexAtomic(this.root, this.index);
    if (!written.ok) {
      throw new Error(written.error.message);
    }
  }

  /**
   * Consume matching cloud-applied expectations against the post-mutation snapshot
   * so they cannot linger and suppress a later same-name user edit.
   * Matches by name/kind/size (not sha256 fingerprint) because this path is the
   * mutation that produced the effect; watcher filtering stays stricter.
   */
  private consumeExpectedMutation(event: LocalVaultEvent): void {
    if (this.expectedEffects.length === 0) {
      return;
    }
    const index = this.expectedEffects.findIndex((effect) => {
      if (event.type === 'deleted') {
        return (
          effect.kind === 'delete' && (effect.name === undefined || effect.name === event.name)
        );
      }
      if (event.type === 'renamed') {
        return (
          effect.kind === 'rename' &&
          (effect.previousName === undefined || effect.previousName === event.from) &&
          (effect.name === undefined || effect.name === event.to)
        );
      }
      if (event.type === 'created' || event.type === 'changed') {
        if (effect.kind !== 'write') {
          return false;
        }
        if (effect.name !== undefined && effect.name !== event.name) {
          return false;
        }
        if (effect.size !== undefined) {
          const child = this.snapshot.get(event.name);
          if (child && child.size !== effect.size) {
            return false;
          }
        }
        return true;
      }
      return false;
    });
    if (index >= 0) {
      this.expectedEffects.splice(index, 1);
    }
  }

  private async withMutation<T>(fn: () => Promise<VaultResult<T>>): Promise<VaultResult<T>> {
    this.mutationDepth += 1;
    try {
      return await fn();
    } finally {
      this.mutationDepth -= 1;
      if (this.mutationDepth === 0) {
        this.debounced.trigger();
      }
    }
  }

  private async scanChildren(): Promise<Map<string, ScannedChild>> {
    if (!this.root) {
      return new Map();
    }
    const root = this.root;
    const dirents = await fs.promises.readdir(root, { withFileTypes: true });
    const next = new Map<string, ScannedChild>();
    for (const dirent of dirents) {
      const name = dirent.name;
      if (isIgnoredVaultChildName(name)) {
        continue;
      }
      if (!validateDirectChildName(name).ok) {
        continue;
      }
      const fullPath = path.join(root, name);
      if (!isPathInsideRoot(root, fullPath)) {
        continue;
      }
      const stats = lstatSafe(fullPath);
      if (!stats || !isEligibleVaultFile(stats)) {
        continue;
      }
      // Skip directory entries reported as files on exotic FS quirks; Dirent helps.
      if (dirent.isDirectory() || dirent.isSymbolicLink()) {
        continue;
      }
      const identity = {
        dev: String(stats.dev),
        ino: String(stats.ino),
      };
      const child: ScannedChild = {
        name,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        identity,
        fingerprintKey: fingerprintKey({ size: stats.size, mtimeMs: stats.mtimeMs }),
      };
      next.set(name, child);
    }
    return next;
  }

  private async rescanQuiet(): Promise<void> {
    this.snapshot = await this.scanChildren();
    if (this.index) {
      const byName = new Map(
        Object.values(this.index.entries).map((entry) => [entry.localName, entry]),
      );
      for (const child of this.snapshot.values()) {
        const entry = byName.get(child.name);
        if (entry) {
          entry.identity = toPlatformIdentity(child);
        }
      }
    }
  }

  private async rescanAndEmit(): Promise<void> {
    if (!this.root) {
      return;
    }
    const previous = this.snapshot;
    const next = await this.scanChildren();
    let events = diffVaultSnapshots(previous, next);
    const filtered = filterExpectedEffects(events, this.expectedEffects, next);
    this.expectedEffects = filtered.remaining;
    events = filtered.events;
    this.snapshot = next;

    if (this.index && events.length > 0) {
      this.applyRenameEventsToIndex(events);
    }

    for (const event of events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  private applyRenameEventsToIndex(events: LocalVaultEvent[]): void {
    if (!this.index) {
      return;
    }
    // In-memory only: durable index writes belong to the coordinator via saveIndex.
    for (const event of events) {
      if (event.type !== 'renamed') {
        continue;
      }
      for (const entry of Object.values(this.index.entries)) {
        if (entry.localName === event.from) {
          entry.localName = event.to;
          const child = this.snapshot.get(event.to);
          if (child) {
            entry.identity = toPlatformIdentity(child);
          }
        }
      }
    }
  }
}

// Keep sync hash helpers available for tests without exporting service internals.
export const __test = {
  sha256FileSync,
  sha256Bytes,
};
