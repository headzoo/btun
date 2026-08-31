import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  bindVaultIndexToOwner,
  createEmptyVaultIndex,
  isSafeLocalName,
  isVaultMetadataName,
  isVaultTempName,
  mimeTypeFromName,
  parseVaultIndexText,
  sanitizePreferredName,
  serializeVaultIndex,
  uniquifyLocalName,
  utf8Bytes,
  validateLocalName,
  vaultTempName,
  VAULT_INDEX_BACKUP_FILENAME,
  VAULT_INDEX_FILENAME,
  type DirectChildSnapshot,
  type ExpectedLocalEffect,
  type LocalVaultEvent,
  type Unsubscribe,
  type VaultAdapter,
  type VaultIndex,
  type VaultIndexLoadResult,
  type VaultResult,
} from '@yard-1/vault';

import { requestVaultRescan } from './mobileVaultEvents';
import {
  defaultRootSettings,
  ensureDefaultVaultDirectory,
  fail,
  indexBackupSidecarFile,
  indexSidecarFile,
  isNativeVaultPlatform,
  loadVaultRootSettings,
  ok,
  saveVaultRootSettings,
  type MobileVaultRootSettings,
  type MobileVaultStatus,
} from './mobileVaultSettings';

function ioMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function validateBasename(name: string): VaultResult<string> {
  const validated = validateLocalName(name);
  if (!validated.ok || isVaultMetadataName(name)) {
    return fail('unsafe-name', `Unsafe local name: ${name}`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return fail('path-escape', `Path separators are not allowed: ${name}`);
  }
  return ok(validated.name);
}

function tempToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isContentUri(uri: string): boolean {
  return uri.startsWith('content://');
}

function childFile(root: Directory, name: string): File {
  return new File(root, name);
}

function snapshotFromFile(file: File): DirectChildSnapshot | null {
  try {
    if (!file.exists) {
      return null;
    }
    const info = file.info();
    if (!info.exists) {
      return null;
    }
    return {
      name: file.name,
      size: typeof info.size === 'number' ? info.size : file.size,
      mtimeMs:
        typeof info.modificationTime === 'number'
          ? info.modificationTime
          : (file.lastModified ?? Date.now()),
    };
  } catch {
    return null;
  }
}

function safeDelete(file: File): void {
  try {
    if (file.exists) {
      file.delete();
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Expo mobile VaultAdapter: flat Documents-backed vault with lifecycle rescans
 * and an expected-effect ledger for cloud echo suppression.
 */
export class MobileVaultAdapter implements VaultAdapter {
  private uid: string | null = null;
  private root: Directory | null = null;
  private settings: MobileVaultRootSettings = defaultRootSettings();
  private index: VaultIndex | null = null;
  private indexLoad: VaultIndexLoadResult = { status: 'missing' };
  private listeners = new Set<(event: LocalVaultEvent) => void>();
  private expectedEffects: ExpectedLocalEffect[] = [];
  private previousNames = new Set<string>();
  private running = false;

  getStatus(): MobileVaultStatus {
    const indexStatus =
      !this.running || this.uid === null
        ? 'idle'
        : this.indexLoad.status === 'ok'
          ? 'ok'
          : this.indexLoad.status;

    return {
      running: this.running,
      uid: this.uid,
      rootUri: this.root?.uri ?? null,
      rootDisplayName: this.settings.displayName ?? null,
      usingDefaultRoot: this.settings.kind === 'app-documents',
      indexInAppDocuments: this.settings.indexInAppDocuments === true,
      indexStatus,
      indexOwnerUid:
        this.indexLoad.status === 'owner-mismatch'
          ? this.indexLoad.ownerUid
          : (this.index?.ownerUid ?? undefined),
      platform: Platform.OS,
    };
  }

  async start(uid: string): Promise<VaultResult<MobileVaultStatus>> {
    if (!isNativeVaultPlatform()) {
      return fail('unsupported', 'Vault filesystem is only available on iOS and Android.');
    }
    if (!uid || uid.length === 0) {
      return fail('permission', 'A Firebase UID is required to start the vault.');
    }

    if (this.running && this.uid && this.uid !== uid) {
      await this.stop();
    }

    this.uid = uid;
    this.running = true;
    this.expectedEffects = [];

    const settings = await loadVaultRootSettings();
    const resolved = await this.resolveRootFromSettings(settings);
    if (!resolved.ok) {
      const fallback = await ensureDefaultVaultDirectory();
      if (!fallback.ok) {
        this.running = false;
        return fallback;
      }
      this.settings = defaultRootSettings();
      this.root = fallback.value;
      await saveVaultRootSettings(this.settings);
    } else {
      this.settings = resolved.value.settings;
      this.root = resolved.value.root;
    }

    await this.cleanStaleTempFiles();
    const indexResult = await this.loadIndexForOwner(uid);
    if (indexResult.status === 'owner-mismatch') {
      this.index = null;
      this.indexLoad = indexResult;
      this.emit({ type: 'invalidated' });
      return ok(this.getStatus());
    }

    await this.rescan('root-change');
    return ok(this.getStatus());
  }

  async stop(): Promise<VaultResult<MobileVaultStatus>> {
    this.running = false;
    this.uid = null;
    this.root = null;
    this.index = null;
    this.indexLoad = { status: 'missing' };
    this.expectedEffects = [];
    this.previousNames.clear();
    this.emit({ type: 'invalidated' });
    return ok(this.getStatus());
  }

  registerExpectedEffect(effect: ExpectedLocalEffect): void {
    this.expectedEffects.push(effect);
  }

  subscribeLocalChanges(listener: (event: LocalVaultEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listDirectChildren(): Promise<DirectChildSnapshot[]> {
    this.assertReady();
    return this.scanChildren();
  }

  /**
   * Resolve a direct-child vault file to a readable URI for native open/share.
   */
  resolveLocalFile(name: string): VaultResult<{ uri: string; mimeType: string; name: string }> {
    try {
      this.assertReady();
    } catch (error) {
      return fail('io', error instanceof Error ? error.message : 'Vault is not ready.');
    }
    const validated = validateBasename(name);
    if (!validated.ok) {
      return validated;
    }
    const file = childFile(this.root!, validated.value);
    if (!file.exists) {
      return fail('not-found', `File not found: ${validated.value}`);
    }
    return ok({
      name: validated.value,
      uri: file.uri,
      mimeType: mimeTypeFromName(validated.value),
    });
  }

  async readBytes(name: string): Promise<Uint8Array> {
    this.assertReady();
    this.assertWritableOwner();
    const validated = validateBasename(name);
    if (!validated.ok) {
      throw new Error(validated.error.message);
    }
    const file = childFile(this.root!, validated.value);
    if (!file.exists) {
      throw new Error(`File not found: ${validated.value}`);
    }
    return file.bytes();
  }

  async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    this.assertReady();
    this.assertWritableOwner();
    const validated = validateBasename(name);
    if (!validated.ok) {
      throw new Error(validated.error.message);
    }
    await this.writeAtomicInternal(validated.value, bytes, { emit: true });
  }

  async rename(from: string, to: string): Promise<void> {
    this.assertReady();
    this.assertWritableOwner();
    const fromValidated = validateBasename(from);
    const toValidated = validateBasename(to);
    if (!fromValidated.ok) {
      throw new Error(fromValidated.error.message);
    }
    if (!toValidated.ok) {
      throw new Error(toValidated.error.message);
    }
    if (fromValidated.value === toValidated.value) {
      return;
    }

    const source = childFile(this.root!, fromValidated.value);
    const dest = childFile(this.root!, toValidated.value);
    if (!source.exists) {
      throw new Error(`File not found: ${fromValidated.value}`);
    }
    if (dest.exists) {
      throw new Error(`Destination already exists: ${toValidated.value}`);
    }

    try {
      source.rename(toValidated.value);
    } catch (error) {
      throw new Error(ioMessage(error, 'Rename failed.'));
    }

    this.previousNames.delete(fromValidated.value);
    this.previousNames.add(toValidated.value);
    const renameEvent: LocalVaultEvent = {
      type: 'renamed',
      from: fromValidated.value,
      to: toValidated.value,
    };
    if (!this.consumeExpected(renameEvent)) {
      this.emit(renameEvent);
    }
    requestVaultRescan('mutation');
  }

  async remove(name: string): Promise<void> {
    this.assertReady();
    this.assertWritableOwner();
    const validated = validateBasename(name);
    if (!validated.ok) {
      throw new Error(validated.error.message);
    }
    const file = childFile(this.root!, validated.value);
    if (!file.exists) {
      throw new Error(`File not found: ${validated.value}`);
    }
    try {
      file.delete();
    } catch (error) {
      throw new Error(ioMessage(error, 'Delete failed.'));
    }
    this.previousNames.delete(validated.value);
    const deleteEvent: LocalVaultEvent = { type: 'deleted', name: validated.value };
    if (!this.consumeExpected(deleteEvent)) {
      this.emit(deleteEvent);
    }
    requestVaultRescan('mutation');
  }

  /**
   * Import bytes as a new vault file with a uniquified preferred name.
   * Used by document/text import primitives.
   */
  async importBytes(
    preferredName: string,
    bytes: Uint8Array,
  ): Promise<VaultResult<DirectChildSnapshot>> {
    try {
      this.assertReady();
      this.assertWritableOwner();
    } catch (error) {
      return fail('io', error instanceof Error ? error.message : 'Vault is not ready.');
    }

    const existing = (await this.scanChildren()).map((child) => child.name);
    const safePreferred = isSafeLocalName(preferredName)
      ? preferredName
      : sanitizePreferredName(preferredName);
    const localName = uniquifyLocalName(safePreferred, existing);

    try {
      await this.writeAtomicInternal(localName, bytes, { emit: true });
      const file = childFile(this.root!, localName);
      const snapshot = snapshotFromFile(file);
      if (!snapshot) {
        return fail('io', 'Imported file could not be read after write.');
      }
      requestVaultRescan('import');
      return ok(snapshot);
    } catch (error) {
      return fail('io', ioMessage(error, 'Import failed.'));
    }
  }

  async useDefaultRoot(): Promise<VaultResult<MobileVaultStatus>> {
    if (!this.running || !this.uid) {
      return fail('permission', 'Start the vault before changing roots.');
    }
    const ensured = await ensureDefaultVaultDirectory();
    if (!ensured.ok) {
      return ensured;
    }
    this.settings = defaultRootSettings();
    this.root = ensured.value;
    const saved = await saveVaultRootSettings(this.settings);
    if (!saved.ok) {
      return saved;
    }
    await this.cleanStaleTempFiles();
    await this.loadIndexForOwner(this.uid);
    await this.rescan('root-change');
    return ok(this.getStatus());
  }

  /**
   * Optional directory selection. Accepted only after write/rename/delete probes.
   * iOS selected folders are session-only per Expo 57 docs, so they are rejected as vault roots.
   */
  async chooseSelectedRoot(): Promise<
    VaultResult<MobileVaultStatus> & { importOnlyHint?: string }
  > {
    if (!this.running || !this.uid) {
      return fail('permission', 'Start the vault before changing roots.');
    }
    if (Platform.OS === 'web') {
      return fail('unsupported', 'Directory selection is not available on web.');
    }
    if (Platform.OS === 'ios') {
      return {
        ...fail(
          'unsupported',
          'iOS folder access does not persist across app restarts. Keep the app Documents vault and import files with the document picker instead.',
        ),
        importOnlyHint:
          'The selected folder can still be used as an import source via the document picker.',
      };
    }

    let picked: Directory;
    try {
      picked = await Directory.pickDirectoryAsync();
    } catch (error) {
      return fail('permission', ioMessage(error, 'Directory selection was cancelled or denied.'));
    }

    const probe = await this.probeWritableRoot(picked);
    if (!probe.ok) {
      return {
        ...probe,
        importOnlyHint:
          'The selected location can still be used as an import source via the document picker.',
      };
    }

    this.settings = {
      kind: 'selected',
      descriptor: picked.uri,
      uri: picked.uri,
      displayName: picked.name || 'Selected folder',
      indexInAppDocuments: probe.value.indexInAppDocuments,
    };
    this.root = picked;
    const saved = await saveVaultRootSettings(this.settings);
    if (!saved.ok) {
      await this.useDefaultRoot();
      return saved;
    }

    await this.cleanStaleTempFiles();
    await this.loadIndexForOwner(this.uid);
    await this.rescan('root-change');
    return ok(this.getStatus());
  }

  async getIndex(): Promise<VaultIndexLoadResult> {
    return this.indexLoad;
  }

  async loadIndex(): Promise<VaultIndexLoadResult> {
    return this.getIndex();
  }

  async saveIndex(index: VaultIndex): Promise<void> {
    const result = await this.replaceIndex(index);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }

  async replaceIndex(index: VaultIndex): Promise<VaultResult<void>> {
    try {
      this.assertReady();
      this.assertWritableOwner();
    } catch (error) {
      return fail('io', error instanceof Error ? error.message : 'Vault is not ready.');
    }
    if (this.uid && index.ownerUid !== this.uid) {
      return fail('owner-mismatch', 'Refusing to persist an index for a different owner.');
    }
    return this.persistIndex(index);
  }

  async rescan(reason: string = 'refresh'): Promise<DirectChildSnapshot[]> {
    if (!this.running || !this.root) {
      return [];
    }
    if (this.indexLoad.status === 'owner-mismatch') {
      this.emit({ type: 'invalidated' });
      return [];
    }

    const children = await this.scanChildren();
    const currentNames = new Set(children.map((child) => child.name));
    const events = this.diffAndConsumeExpected(this.previousNames, currentNames, children);
    this.previousNames = currentNames;
    for (const event of events) {
      this.emit(event);
    }
    if (events.length === 0 && (reason === 'app-active' || reason === 'focus')) {
      this.emit({ type: 'invalidated' });
    }
    return children;
  }

  private emit(event: LocalVaultEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors must not break the adapter
      }
    }
  }

  private assertReady(): void {
    if (!this.running || !this.root || !this.uid) {
      throw new Error('Vault adapter is not started.');
    }
  }

  private assertWritableOwner(): void {
    if (this.indexLoad.status === 'owner-mismatch') {
      throw new Error('Vault index belongs to a different account.');
    }
  }

  private async resolveRootFromSettings(
    settings: MobileVaultRootSettings,
  ): Promise<VaultResult<{ settings: MobileVaultRootSettings; root: Directory }>> {
    if (settings.kind !== 'selected' || !settings.uri) {
      const ensured = await ensureDefaultVaultDirectory();
      if (!ensured.ok) {
        return ensured;
      }
      return ok({ settings: defaultRootSettings(), root: ensured.value });
    }

    try {
      const dir = new Directory(settings.uri);
      if (!dir.exists) {
        return fail('permission', 'Previously selected vault folder is no longer accessible.');
      }
      const probe = await this.probeWritableRoot(dir);
      if (!probe.ok) {
        return probe;
      }
      return ok({
        settings: {
          ...settings,
          indexInAppDocuments: probe.value.indexInAppDocuments,
        },
        root: dir,
      });
    } catch (error) {
      return fail('permission', ioMessage(error, 'Selected vault folder is inaccessible.'));
    }
  }

  private async probeWritableRoot(
    dir: Directory,
  ): Promise<VaultResult<{ indexInAppDocuments: boolean }>> {
    const probeName = vaultTempName(`probe-${tempToken()}`);
    const renamedName = vaultTempName(`probe-renamed-${tempToken()}`);
    const probeFile = childFile(dir, probeName);
    const renamedFile = childFile(dir, renamedName);
    let indexInAppDocuments = false;

    try {
      if (isContentUri(dir.uri) && Platform.OS === 'android') {
        // SAF roots are allowed only when mutation probes succeed below.
      }

      probeFile.create({ overwrite: true });
      probeFile.write(utf8Bytes('buddy-tunnel-probe'));
      const roundTrip = await probeFile.bytes();
      if (roundTrip.byteLength === 0) {
        throw new Error('Probe write produced an empty file.');
      }
      probeFile.rename(renamedName);
      if (!renamedFile.exists) {
        throw new Error('Probe rename did not produce the target file.');
      }
      renamedFile.delete();

      // Index persistence probe: try the real index basename without clobbering an existing index.
      const indexProbe = childFile(dir, VAULT_INDEX_FILENAME);
      if (indexProbe.exists) {
        indexInAppDocuments = false;
      } else {
        try {
          indexProbe.create({ overwrite: true });
          indexProbe.write(utf8Bytes('{}\n'));
          indexProbe.delete();
          indexInAppDocuments = false;
        } catch {
          safeDelete(indexProbe);
          indexInAppDocuments = true;
        }
      }

      return ok({ indexInAppDocuments });
    } catch (error) {
      safeDelete(probeFile);
      safeDelete(renamedFile);
      return fail(
        'unsupported',
        `Selected folder is not a writable vault root (${ioMessage(error, 'probe failed')}).`,
      );
    }
  }

  private async cleanStaleTempFiles(): Promise<void> {
    if (!this.root?.exists) {
      return;
    }
    try {
      for (const item of this.root.list()) {
        if (item instanceof File && isVaultTempName(item.name)) {
          safeDelete(item);
        }
      }
    } catch {
      // ignore listing failures during cleanup
    }
  }

  private async scanChildren(): Promise<DirectChildSnapshot[]> {
    if (!this.root?.exists) {
      return [];
    }
    const out: DirectChildSnapshot[] = [];
    try {
      for (const item of this.root.list()) {
        if (!(item instanceof File)) {
          continue;
        }
        if (isVaultMetadataName(item.name) || !isSafeLocalName(item.name)) {
          continue;
        }
        const snapshot = snapshotFromFile(item);
        if (snapshot) {
          out.push(snapshot);
        }
      }
    } catch (error) {
      throw new Error(ioMessage(error, 'Failed to list vault contents.'));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private diffAndConsumeExpected(
    previous: Set<string>,
    current: Set<string>,
    _children: DirectChildSnapshot[],
  ): LocalVaultEvent[] {
    const events: LocalVaultEvent[] = [];
    const deleted = [...previous].filter((name) => !current.has(name));
    const created = [...current].filter((name) => !previous.has(name));
    const stable = [...current].filter((name) => previous.has(name));

    // Pair a single delete+create as rename (common cloud/local rename shape).
    if (deleted.length === 1 && created.length === 1) {
      const from = deleted[0]!;
      const to = created[0]!;
      if (!this.consumeExpected({ type: 'renamed', from, to })) {
        events.push({ type: 'renamed', from, to });
      }
    } else {
      for (const name of deleted) {
        if (!this.consumeExpected({ type: 'deleted', name })) {
          events.push({ type: 'deleted', name });
        }
      }
      for (const name of created) {
        if (!this.consumeExpected({ type: 'created', name })) {
          events.push({ type: 'created', name });
        }
      }
    }

    for (const name of stable) {
      // Consume matching write expectations without emitting speculative changed events.
      this.consumeExpected({ type: 'changed', name });
    }

    return events;
  }

  private consumeExpected(event: LocalVaultEvent): boolean {
    const index = this.expectedEffects.findIndex((effect) => {
      if (event.type === 'deleted') {
        return effect.kind === 'delete' && effect.name === event.name;
      }
      if (event.type === 'renamed') {
        return (
          effect.kind === 'rename' && effect.previousName === event.from && effect.name === event.to
        );
      }
      if (event.type === 'created' || event.type === 'changed') {
        if (effect.kind !== 'write' && effect.kind !== 'rename') {
          return false;
        }
        if (effect.name !== event.name) {
          return false;
        }
        return true;
      }
      return false;
    });
    if (index < 0) {
      return false;
    }
    this.expectedEffects.splice(index, 1);
    return true;
  }

  private async writeAtomicInternal(
    name: string,
    bytes: Uint8Array,
    options: { emit: boolean },
  ): Promise<void> {
    const root = this.root!;
    const tempName = vaultTempName(tempToken());
    const temp = childFile(root, tempName);
    const target = childFile(root, name);
    const existed = target.exists;

    try {
      temp.create({ overwrite: true });
      temp.write(bytes);
      if (target.exists) {
        target.delete();
      }
      temp.rename(name);
    } catch (error) {
      safeDelete(temp);
      throw new Error(ioMessage(error, 'Atomic write failed.'));
    }

    this.previousNames.add(name);
    if (options.emit) {
      const event: LocalVaultEvent = { type: existed ? 'changed' : 'created', name };
      if (!this.consumeExpected(event)) {
        this.emit(event);
      }
      requestVaultRescan('mutation');
    }
  }

  private indexFiles(): { primary: File; backup: File } {
    if (this.settings.indexInAppDocuments) {
      return {
        primary: indexSidecarFile(this.settings.descriptor),
        backup: indexBackupSidecarFile(this.settings.descriptor),
      };
    }
    return {
      primary: childFile(this.root!, VAULT_INDEX_FILENAME),
      backup: childFile(this.root!, VAULT_INDEX_BACKUP_FILENAME),
    };
  }

  private async loadIndexForOwner(uid: string): Promise<VaultIndexLoadResult> {
    const { primary, backup } = this.indexFiles();
    let loaded = await this.readIndexFile(primary);
    if (loaded.status === 'corrupt' || loaded.status === 'unsupported-version') {
      const fromBackup = await this.readIndexFile(backup);
      if (fromBackup.status === 'ok') {
        loaded = fromBackup;
      }
    }

    if (loaded.status === 'missing') {
      const empty = createEmptyVaultIndex(uid);
      const persisted = await this.persistIndex(empty);
      if (!persisted.ok) {
        this.index = null;
        this.indexLoad = { status: 'corrupt', error: persisted.error.message };
        return this.indexLoad;
      }
      this.index = empty;
      this.indexLoad = { status: 'ok', index: empty };
      return this.indexLoad;
    }

    if (loaded.status !== 'ok') {
      this.index = null;
      this.indexLoad = loaded;
      return loaded;
    }

    const bound = bindVaultIndexToOwner(loaded.index, uid);
    this.indexLoad = bound;
    this.index = bound.status === 'ok' ? bound.index : null;
    return bound;
  }

  private async readIndexFile(file: File): Promise<VaultIndexLoadResult> {
    try {
      if (!file.exists) {
        return { status: 'missing' };
      }
      const text = await file.text();
      return parseVaultIndexText(text);
    } catch (error) {
      return { status: 'corrupt', error: ioMessage(error, 'Failed to read vault index.') };
    }
  }

  private async persistIndex(index: VaultIndex): Promise<VaultResult<void>> {
    const { primary, backup } = this.indexFiles();
    const text = serializeVaultIndex(index);
    const bytes = utf8Bytes(text);
    const tempName = this.settings.indexInAppDocuments
      ? vaultTempName(`index-${tempToken()}`)
      : vaultTempName(`index-${tempToken()}`);

    // Temp sibling lives next to the primary index file's parent directory.
    const tempParent = this.settings.indexInAppDocuments ? primary.parentDirectory : this.root!;
    const temp = new File(tempParent, tempName);

    try {
      if (primary.exists) {
        try {
          primary.copySync(backup, { overwrite: true });
        } catch {
          // backup is best-effort
        }
      }
      temp.create({ overwrite: true });
      temp.write(bytes);
      if (primary.exists) {
        primary.delete();
      }
      // Move/rename into the durable index name.
      if (this.settings.indexInAppDocuments) {
        temp.rename(primary.name);
      } else {
        temp.rename(VAULT_INDEX_FILENAME);
      }
      this.index = index;
      this.indexLoad = { status: 'ok', index };
      return ok(undefined);
    } catch (error) {
      safeDelete(temp);
      return fail('io', ioMessage(error, 'Failed to persist vault index.'));
    }
  }
}

let sharedAdapter: MobileVaultAdapter | null = null;

export function getMobileVaultAdapter(): MobileVaultAdapter {
  if (!sharedAdapter) {
    sharedAdapter = new MobileVaultAdapter();
  }
  return sharedAdapter;
}
