import type {
  DirectChildSnapshot,
  ExpectedLocalEffect,
  LiveChildEvent,
  LocalVaultEvent,
  TombstoneEvent,
  Unsubscribe,
  VaultAdapter,
  VaultIndexStore,
  VaultRootStatus,
  VaultSyncSnapshot,
  VaultTransport,
} from './contracts';
import type { LiveChildParse } from './parse';
import type {
  AppliedRemoteState,
  PendingOperation,
  PendingOpState,
  PlatformFileIdentity,
  VaultIndex,
  VaultIndexEntry,
} from './index-schema';
import { createEmptyVaultIndex } from './index-schema';
import {
  latestPendingForId,
  markPending,
  newPendingOpId,
  recoverInFlightOperations,
  replacePendingForId,
  removePendingForId,
} from './journal';
import type { FileEntry, RemoteClock, RemoteFileRecord, RemoteTombstone } from './model';
import { clockFromRecord, newVaultRevision } from './model';
import { mimeTypeFromName, sanitizePreferredName, validateLocalName } from './names';
import type { UniquifyOptions } from './names';
import { sha256Hex, utf8Bytes } from './content';
import {
  chooseLocalName,
  collectKnownIds,
  decideReconcile,
  rebindIndexNamesByIdentity,
  unmappedLocalNames,
  type ReconcileInput,
} from './reconcile';

const DEFAULT_MAX_PARALLEL = 4;

export interface VaultSyncOptions {
  uid?: string;
  adapter: VaultAdapter;
  transport: VaultTransport;
  indexStore?: VaultIndexStore;
  caseSensitiveNames?: boolean;
  maxParallel?: number;
  now?: () => number;
  /** When set, coordinator emits structured startup/sync diagnostics. */
  debugLog?: VaultDebugLog;
}

export type VaultDebugLog = (scope: string, message: string, detail?: unknown) => void;

export interface VaultRefreshOptions {
  /** Rescan local files only — does not wait for cloud sync pumps. */
  localOnly?: boolean;
}

export interface VaultStartOptions {
  /** When false, return after the local index is ready; remote catalog sync continues in the background. */
  awaitRemote?: boolean;
}

export interface VaultSyncCommands {
  refresh(options?: VaultRefreshOptions): Promise<void>;
  rename(id: string, preferredName: string): Promise<void>;
  remove(id: string): Promise<void>;
  importBytes(preferredName: string, bytes: Uint8Array): Promise<{ id: string; localName: string }>;
}

export function emptyVaultSyncSnapshot(): VaultSyncSnapshot {
  return {
    generation: 0,
    entries: [],
    initialLoading: false,
    bootstrapped: false,
    connected: false,
    syncStatusLabel: 'Starting vault…',
    rootStatus: { kind: 'idle' },
    ownerUid: null,
  };
}

function cloneIndex(index: VaultIndex): VaultIndex {
  return structuredClone(index);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function mergePlatformIdentity(
  previous: PlatformFileIdentity | undefined,
  child: DirectChildSnapshot | undefined,
  sha256?: string,
): PlatformFileIdentity | undefined {
  if (!previous && !child && !sha256) {
    return undefined;
  }
  const identity: PlatformFileIdentity = { ...previous };
  if (child) {
    const metadataChanged =
      (previous?.size !== undefined && previous.size !== child.size) ||
      (previous?.mtimeMs !== undefined && previous.mtimeMs !== child.mtimeMs);
    identity.size = child.size;
    identity.mtimeMs = child.mtimeMs;
    if (child.identity?.dev) {
      identity.dev = child.identity.dev;
    }
    if (child.identity?.ino) {
      identity.ino = child.identity.ino;
    }
    // Never keep a stale hash alongside newer size/mtime — localHash would trust it.
    if (metadataChanged && sha256 === undefined) {
      delete identity.sha256;
    }
  }
  if (sha256 !== undefined) {
    identity.sha256 = sha256;
  }
  return identity;
}

function platformIdentitiesEqual(
  left: PlatformFileIdentity | undefined,
  right: PlatformFileIdentity | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

function blobPathOf(record: RemoteFileRecord): string | undefined {
  return record.content.kind === 'blob' ? record.content.storagePath : undefined;
}

function appliedFromRecord(
  record: RemoteFileRecord,
  preferredName = record.name,
): AppliedRemoteState {
  const applied: AppliedRemoteState = {
    revision: record.revision,
    updatedAt: record.updatedAt,
    sha256: record.sha256,
    size: record.size,
    preferredName,
  };
  const blobPath = blobPathOf(record);
  if (blobPath) {
    applied.blobPath = blobPath;
  }
  return applied;
}

/**
 * Serialized per-ID state machine over a platform adapter and Firebase transport.
 * Local materialization is authoritative for display.
 */
export class VaultSyncCoordinator {
  private readonly adapter: VaultAdapter;
  private readonly indexStore: VaultIndexStore;
  private readonly transport: VaultTransport;
  private readonly uniquifyOptions: UniquifyOptions;
  private readonly maxParallel: number;
  private readonly now: () => number;

  private generation = 0;
  private started = false;
  private bootstrapping = false;
  private bootstrapped = false;
  private outwardEnabled = false;
  private allowAdopt = false;
  private remoteCatalogReady = false;
  private catalogEpoch = 0;
  private catalogRefreshChain: Promise<void> = Promise.resolve();
  private connected = false;
  private remoteSyncing = false;
  private remoteBootstrapComplete = false;
  private catalogError: string | null = null;
  private rootStatus: VaultRootStatus = { kind: 'idle' };
  private index: VaultIndex;
  private locals = new Map<string, DirectChildSnapshot>();
  private live = new Map<string, LiveChildParse>();
  private tombstones = new Map<string, RemoteTombstone>();
  private hashes = new Map<string, string>();
  private errors = new Map<string, string>();
  /** IDs observed locally this generation — gates delete-from-absence. */
  private landedThisGeneration = new Set<string>();
  private reservedNames = new Set<string>();
  private dirty = new Set<string>();
  private running = new Set<string>();
  private activeCount = 0;
  private pumpScheduled = false;
  private unsubs: Unsubscribe[] = [];
  private bufferedLocal: LocalVaultEvent[] = [];
  private listeners = new Set<(snapshot: VaultSyncSnapshot) => void>();
  private latestSnapshot: VaultSyncSnapshot = emptyVaultSyncSnapshot();
  private persistChain: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private localEventsInFlight = 0;
  private connectivityWork = 0;
  private readonly debugLog?: VaultDebugLog;
  private lastDebugStatusLabel: string | null = null;

  constructor(options: VaultSyncOptions) {
    this.adapter = options.adapter;
    this.indexStore = options.indexStore ?? (options.adapter as unknown as VaultIndexStore);
    this.transport = options.transport;
    this.uniquifyOptions = { caseSensitive: options.caseSensitiveNames === true };
    this.maxParallel = Math.max(1, options.maxParallel ?? DEFAULT_MAX_PARALLEL);
    this.now = options.now ?? (() => Date.now());
    this.debugLog = options.debugLog;
    this.index = createEmptyVaultIndex(options.transport.uid);
  }

  private log(scope: string, message: string, detail?: unknown): void {
    this.debugLog?.(scope, message, detail);
  }

  get commands(): VaultSyncCommands {
    return {
      refresh: (options) => this.refresh(options),
      rename: (id, preferredName) => this.rename(id, preferredName),
      remove: (id) => this.delete(id),
      importBytes: (preferredName, bytes) => this.importBytes(preferredName, bytes),
    };
  }

  subscribe(listener: (snapshot: VaultSyncSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.latestSnapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): VaultSyncSnapshot {
    return this.latestSnapshot;
  }

  async start(options?: VaultStartOptions): Promise<void> {
    this.generation += 1;
    const gen = this.generation;
    this.log('coordinator', 'start', {
      gen,
      awaitRemote: options?.awaitRemote ?? true,
      uid: this.transport.uid,
    });
    this.clearRuntime();
    this.started = true;
    this.bootstrapping = true;
    this.rootStatus = { kind: 'ready' };
    this.index = createEmptyVaultIndex(this.transport.uid);
    this.emitSnapshot();

    try {
      this.log('coordinator', 'bootstrapLocal begin', { gen });
      const local = await this.bootstrapLocal(gen);
      if (!this.isGen(gen)) {
        return;
      }
      if (local === 'blocked') {
        this.log('coordinator', 'bootstrapLocal blocked', { gen, rootStatus: this.rootStatus });
        this.bootstrapping = false;
        this.emitSnapshot();
        return;
      }
      this.log('coordinator', 'bootstrapLocal ok', {
        gen,
        indexEntries: Object.keys(this.index.entries).length,
      });
    } catch (error) {
      if (!this.isGen(gen)) {
        return;
      }
      this.log('coordinator', 'bootstrapLocal failed', {
        gen,
        error: errorMessage(error, 'unknown'),
      });
      this.rootStatus = {
        kind: 'error',
        message: errorMessage(error, 'Vault sync failed to start.'),
      };
      this.bootstrapping = false;
      this.emitSnapshot();
      return;
    }

    if (!this.isGen(gen)) {
      return;
    }
    this.bootstrapping = false;
    this.bootstrapped = true;
    this.emitSnapshot();

    const remote = this.bootstrapRemote(gen);
    if (options?.awaitRemote === false) {
      this.log('coordinator', 'local ready; remote bootstrap continues in background', { gen });
      void remote.catch((error) => {
        this.log('coordinator', 'remote bootstrap failed', {
          gen,
          error: errorMessage(error, 'unknown'),
        });
      });
      this.notifyIdle();
      return;
    }
    await remote;
    this.notifyIdle();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.clearRuntime();
    this.rootStatus = { kind: 'idle' };
    this.connected = false;
    this.emitSnapshot();
    this.notifyIdle();
  }

  async refresh(options?: VaultRefreshOptions): Promise<void> {
    if (!this.started) {
      return;
    }
    const gen = this.generation;
    await this.refreshLocals();
    if (!this.isGen(gen)) {
      return;
    }
    if (options?.localOnly) {
      await this.withAdoptAllowed(async () => {
        await this.adoptUnmapped();
      });
      this.enqueueKnown();
      this.schedulePump(gen);
      this.emitSnapshot();
      void this.catchUpCloud(gen);
      return;
    }
    const listed = await this.refreshRemoteCatalog(gen);
    if (!this.isGen(gen)) {
      return;
    }
    if (listed && !this.outwardEnabled) {
      const ingested = await this.ingestRemoteCatalog(gen);
      if (!this.isGen(gen)) {
        return;
      }
      if (ingested) {
        this.outwardEnabled = true;
        this.flushBufferedLocal();
        await this.refreshLocals();
      }
    }
    this.enqueueKnown();
    if (this.allowAdopt) {
      await this.adoptUnmapped();
    }
    this.schedulePump(gen);
    await this.waitForIdle();
  }

  async rename(id: string, preferredName: string): Promise<void> {
    const validated = validateLocalName(preferredName);
    if (!validated.ok) {
      throw new Error(`Unsafe filename: ${preferredName}`);
    }
    const entry = this.index.entries[id];
    if (!entry) {
      throw new Error(`Unknown vault file: ${id}`);
    }
    const currentName = entry.localName;
    const target = chooseLocalName(
      validated.name,
      currentName,
      this.occupiedNames(),
      this.uniquifyOptions,
    );
    const applied = entry.appliedRemote;
    const expected: RemoteClock | null = applied
      ? { updatedAt: applied.updatedAt, revision: applied.revision }
      : null;
    if (!expected) {
      throw new Error('Cannot rename a file that has not been published yet.');
    }
    if (target !== currentName && this.locals.has(currentName)) {
      await this.expect({
        id,
        kind: 'rename',
        name: target,
        previousName: currentName,
        revision: expected.revision,
      });
      if (!this.started) {
        return;
      }
      await this.adapter.rename(currentName, target);
      this.moveLocal(currentName, target);
    }
    const revision = newVaultRevision();
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      const current = next.entries[id];
      if (current) {
        next.entries[id] = { ...current, localName: target };
      }
      next.pendingOperations = replacePendingForId(next.pendingOperations, {
        kind: 'rename',
        opId: newPendingOpId(),
        id,
        revision,
        queuedAt: this.now(),
        state: 'queued',
        expected,
        preferredName: validated.name,
      });
      return next;
    });
    this.enqueue(id);
    this.schedulePump(this.generation);
    await this.waitForIdle();
  }

  async delete(id: string): Promise<void> {
    const entry = this.index.entries[id];
    if (!entry && !this.live.has(id)) {
      throw new Error(`Unknown vault file: ${id}`);
    }
    const localName = entry?.localName;
    const applied = entry?.appliedRemote;
    const live = this.v1Record(id);
    const expected: RemoteClock | null = applied
      ? { updatedAt: applied.updatedAt, revision: applied.revision }
      : live
        ? clockFromRecord(live)
        : null;
    if (expected) {
      const revision = newVaultRevision();
      await this.commitIndex((index) => {
        const next = cloneIndex(index);
        next.pendingOperations = replacePendingForId(next.pendingOperations, {
          kind: 'delete',
          opId: newPendingOpId(),
          id,
          revision,
          queuedAt: this.now(),
          state: 'queued',
          expected,
        });
        return next;
      });
    }
    if (localName && this.locals.has(localName)) {
      await this.expect({
        id,
        kind: 'delete',
        name: localName,
        revision: expected?.revision ?? newVaultRevision(),
      });
      if (!this.started) {
        return;
      }
      await this.adapter.remove(localName);
      this.locals.delete(localName);
      this.hashes.delete(localName);
    }
    if (!expected) {
      await this.commitIndex((index) => {
        const next = cloneIndex(index);
        delete next.entries[id];
        next.pendingOperations = removePendingForId(next.pendingOperations, id);
        return next;
      });
      this.emitSnapshot();
      return;
    }
    this.enqueue(id);
    this.schedulePump(this.generation);
    await this.waitForIdle();
  }

  async importBytes(
    preferredName: string,
    bytes: Uint8Array,
  ): Promise<{ id: string; localName: string }> {
    if (!this.started || this.rootStatus.kind !== 'ready') {
      throw new Error('Vault sync is not running.');
    }
    const validated = validateLocalName(preferredName);
    const safe = validated.ok ? validated.name : sanitizePreferredName(preferredName);
    const localName = chooseLocalName(safe, null, this.occupiedNames(), this.uniquifyOptions);
    await this.expect({
      id: 'import',
      kind: 'write',
      name: localName,
      size: bytes.byteLength,
      revision: newVaultRevision(),
    });
    await this.adapter.writeAtomic(localName, bytes);
    this.locals.set(localName, {
      name: localName,
      size: bytes.byteLength,
      mtimeMs: this.now(),
    });
    this.hashes.set(localName, await sha256Hex(bytes));
    const previousAdopt = this.allowAdopt;
    this.allowAdopt = true;
    try {
      await this.adoptName(localName);
    } finally {
      this.allowAdopt = previousAdopt;
    }
    this.schedulePump(this.generation);
    await this.waitForIdle();
    const entry = this.entryByLocalName(localName);
    if (!entry) {
      throw new Error('Import did not produce a vault identity.');
    }
    return { id: entry.id, localName };
  }

  async retry(id: string): Promise<void> {
    this.errors.delete(id);
    this.enqueue(id);
    this.schedulePump(this.generation);
    await this.waitForIdle();
  }

  async waitForIdle(timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (this.bootstrapping || this.hasQueuedWork()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Vault sync did not become idle in time.');
      }
      await this.waitForWorkPulse();
    }
  }

  private hasQueuedWork(options?: { ignoreConnectivity?: boolean }): boolean {
    return (
      this.dirty.size > 0 ||
      this.running.size > 0 ||
      this.activeCount > 0 ||
      this.pumpScheduled ||
      this.localEventsInFlight > 0 ||
      (!options?.ignoreConnectivity && this.connectivityWork > 0)
    );
  }

  /**
   * Drain queued pumps for this generation. No timeout by default: catalog ingest
   * must wait for materialize to finish rather than abort and re-enable deletes.
   * Returns false if the generation was cancelled mid-wait.
   */
  private async waitForWork(
    gen: number,
    options?: { ignoreConnectivity?: boolean; timeoutMs?: number },
  ): Promise<boolean> {
    const start = options?.timeoutMs ? Date.now() : 0;
    while (this.isGen(gen) && this.hasQueuedWork(options)) {
      if (options?.timeoutMs && Date.now() - start > options.timeoutMs) {
        return false;
      }
      await this.waitForWorkPulse();
    }
    return this.isGen(gen);
  }

  private waitForWorkPulse(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
      setTimeout(resolve, 8);
    });
  }

  private isGen(gen: number): boolean {
    return this.started && this.generation === gen;
  }

  private clearRuntime(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.unsubs = [];
    this.started = false;
    this.bootstrapping = false;
    this.bootstrapped = false;
    this.outwardEnabled = false;
    this.allowAdopt = false;
    this.remoteCatalogReady = false;
    this.catalogEpoch += 1;
    this.dirty.clear();
    this.running.clear();
    this.activeCount = 0;
    this.pumpScheduled = false;
    this.bufferedLocal = [];
    this.reservedNames.clear();
    this.errors.clear();
    this.hashes.clear();
    this.landedThisGeneration.clear();
    this.live.clear();
    this.tombstones.clear();
    this.locals.clear();
    this.localEventsInFlight = 0;
    this.connectivityWork = 0;
    this.remoteSyncing = false;
    this.remoteBootstrapComplete = false;
    this.catalogError = null;
  }

  private buildSyncStatusLabel(): string {
    if (this.bootstrapping) {
      return 'Starting local vault…';
    }
    if (this.remoteSyncing) {
      return 'Connecting to cloud…';
    }
    if (!this.remoteBootstrapComplete && this.bootstrapped) {
      return 'Finishing cloud sync…';
    }
    if (this.connected && this.remoteCatalogReady) {
      return 'Online';
    }
    if (this.catalogError) {
      return `Cloud unavailable — ${this.catalogError}`;
    }
    if (!this.remoteCatalogReady && this.bootstrapped) {
      return 'Cloud catalog not loaded — uploads will retry when connected';
    }
    if (!this.connected) {
      return 'Offline — changes queue locally until reconnected';
    }
    return 'Syncing…';
  }

  private async bootstrapLocal(gen: number): Promise<'ok' | 'blocked'> {
    const loaded = await this.indexStore.loadIndex();
    if (!this.isGen(gen)) {
      return 'blocked';
    }
    if (loaded.status === 'owner-mismatch') {
      this.rootStatus = {
        kind: 'owner-mismatch',
        ownerUid: loaded.ownerUid,
        message: `This vault folder belongs to another account (${loaded.ownerUid}).`,
      };
      return 'blocked';
    }
    if (loaded.status === 'ok') {
      this.index = cloneIndex(loaded.index);
      this.index.pendingOperations = recoverInFlightOperations(this.index.pendingOperations);
      if (!this.index.appliedTombstones) {
        this.index.appliedTombstones = {};
      }
    } else if (loaded.status === 'unsupported-version') {
      this.rootStatus = {
        kind: 'error',
        message: `Vault index version ${loaded.version} is not supported.`,
      };
      return 'blocked';
    } else {
      this.index = createEmptyVaultIndex(this.transport.uid);
    }

    await this.refreshLocals();
    if (!this.isGen(gen)) {
      return 'blocked';
    }
    const rebound = rebindIndexNamesByIdentity(this.index, [...this.locals.values()]);
    if (rebound !== this.index) {
      await this.commitIndex(() => rebound);
    }
    return 'ok';
  }

  private async bootstrapRemote(gen: number): Promise<void> {
    this.log('remote', 'bootstrap begin', { gen });
    this.remoteSyncing = true;
    this.emitSnapshot();
    try {
      await this.refreshRemoteCatalog(gen);
    } finally {
      if (this.isGen(gen)) {
        this.remoteSyncing = false;
        this.log('remote', 'initial catalog fetch finished', {
          gen,
          remoteCatalogReady: this.remoteCatalogReady,
          catalogError: this.catalogError,
        });
        this.emitSnapshot();
      }
    }
    if (!this.isGen(gen)) {
      return;
    }

    try {
      this.subscribeRemote(gen);
      this.log('remote', 'waiting for initial remote work', { gen });
      await this.waitForWork(gen, { ignoreConnectivity: true, timeoutMs: 30_000 });

      if (this.remoteCatalogReady) {
        this.log('remote', 'ingesting remote catalog', { gen });
        const ingested = await this.ingestRemoteCatalog(gen);
        if (!this.isGen(gen)) {
          return;
        }
        if (ingested) {
          await this.commitIndex((index) => index);
          this.outwardEnabled = true;
          this.log('remote', 'remote catalog ingested', { gen });
        } else if (this.remoteCatalogReady && this.live.size === 0 && this.tombstones.size === 0) {
          this.outwardEnabled = true;
          this.allowAdopt = true;
          this.log('remote', 'empty remote catalog; outward sync enabled', { gen });
        }
      }

      this.subscribeLocal(gen);
      if (this.outwardEnabled) {
        this.flushBufferedLocal();
      }
      await this.refreshLocals();
      if (!this.isGen(gen)) {
        return;
      }
      if (this.allowAdopt) {
        await this.adoptUnmapped();
      }
      this.enqueueKnown();
      this.schedulePump(gen);
      await this.waitForWork(gen, { ignoreConnectivity: true, timeoutMs: 120_000 });
    } finally {
      if (this.isGen(gen)) {
        this.remoteBootstrapComplete = true;
        this.log('remote', 'bootstrap complete', {
          gen,
          connected: this.connected,
          remoteCatalogReady: this.remoteCatalogReady,
          outwardEnabled: this.outwardEnabled,
          catalogError: this.catalogError,
        });
        this.emitSnapshot();
      }
    }
  }

  /** Queue pending cloud work without blocking the caller on the full pump drain. */
  private async catchUpCloud(gen: number): Promise<void> {
    if (!this.isGen(gen)) {
      return;
    }
    const listed = await this.refreshRemoteCatalog(gen);
    if (!this.isGen(gen)) {
      return;
    }
    if (!listed) {
      this.emitSnapshot();
      return;
    }
    if (!this.outwardEnabled) {
      const ingested = await this.ingestRemoteCatalog(gen);
      if (!this.isGen(gen)) {
        return;
      }
      if (ingested) {
        this.outwardEnabled = true;
        this.flushBufferedLocal();
        await this.refreshLocals();
      } else if (this.remoteCatalogReady && this.live.size === 0 && this.tombstones.size === 0) {
        this.outwardEnabled = true;
      }
    }
    if (!this.isGen(gen)) {
      return;
    }
    if (this.allowAdopt) {
      await this.adoptUnmapped();
    }
    this.enqueueKnown();
    this.schedulePump(gen);
    this.emitSnapshot();
  }

  private async withAdoptAllowed<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.allowAdopt;
    this.allowAdopt = true;
    try {
      return await fn();
    } finally {
      this.allowAdopt = previous;
    }
  }

  /**
   * Full remote catalog list. Absences are only trustworthy after this succeeds.
   * Concurrent calls are serialized; disconnect bumps catalogEpoch to discard stale results.
   */
  private refreshRemoteCatalog(gen: number): Promise<boolean> {
    const run = this.catalogRefreshChain.then(() => this.refreshRemoteCatalogOnce(gen));
    this.catalogRefreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async refreshRemoteCatalogOnce(gen: number): Promise<boolean> {
    const epoch = this.catalogEpoch;
    const startedAt = this.now();
    this.log('catalog', 'fetch begin', { gen, epoch });
    try {
      const [children, tombs] = await Promise.all([
        this.transport.listLiveChildren(),
        this.transport.listTombstones(),
      ]);
      if (!this.isGen(gen) || epoch !== this.catalogEpoch) {
        return false;
      }
      const previousLiveIds = [...this.live.keys()];
      const previousTombIds = [...this.tombstones.keys()];
      this.live.clear();
      this.tombstones.clear();
      for (const child of children) {
        this.live.set(child.id, child);
      }
      for (const item of tombs) {
        this.tombstones.set(item.id, item.tombstone);
      }
      for (const id of previousLiveIds) {
        if (!this.live.has(id)) {
          this.enqueue(id);
        }
      }
      for (const id of previousTombIds) {
        if (!this.tombstones.has(id)) {
          this.enqueue(id);
        }
      }
      this.remoteCatalogReady = true;
      this.catalogError = null;
      this.connected = true;
      this.log('catalog', 'fetch ok', {
        gen,
        epoch,
        elapsedMs: this.now() - startedAt,
        liveCount: children.length,
        tombstoneCount: tombs.length,
      });
      return true;
    } catch (error) {
      if (this.isGen(gen) && epoch === this.catalogEpoch) {
        // Keep any positive knowledge already in maps, but absences stay untrusted.
        this.remoteCatalogReady = false;
        this.catalogError = errorMessage(error, 'Could not load cloud catalog.');
        this.log('catalog', 'fetch failed', {
          gen,
          epoch,
          elapsedMs: this.now() - startedAt,
          error: this.catalogError,
        });
      }
      return false;
    }
  }

  private markRemoteCatalogUntrusted(): void {
    this.catalogEpoch += 1;
    this.remoteCatalogReady = false;
  }

  /**
   * After a successful list, materialize/reconcile before treating missing locals
   * as user deletes, then adopt unmapped locals.
   * Leaves outwardEnabled false until the caller enables it after a successful return.
   * Never restores a prior outwardEnabled value on failure — that would let
   * in-flight pumps queue-delete indexed remotes that are still downloading.
   */
  private async ingestRemoteCatalog(gen: number): Promise<boolean> {
    this.outwardEnabled = false;
    this.enqueueKnown();
    this.schedulePump(gen);
    const drained = await this.waitForWork(gen, { ignoreConnectivity: true });
    if (!this.isGen(gen) || !drained) {
      return false;
    }
    this.allowAdopt = true;
    await this.adoptUnmapped();
    this.schedulePump(gen);
    const drainedAdopt = await this.waitForWork(gen, { ignoreConnectivity: true });
    return this.isGen(gen) && drainedAdopt;
  }

  private async onConnectivityChange(connected: boolean, gen: number): Promise<void> {
    if (!this.isGen(gen)) {
      return;
    }
    this.connectivityWork += 1;
    try {
      if (!connected) {
        this.connected = false;
        this.markRemoteCatalogUntrusted();
        this.emitSnapshot();
        return;
      }

      this.connected = true;
      this.emitSnapshot();
      const listed = await this.refreshRemoteCatalog(gen);
      if (!this.isGen(gen) || !listed) {
        return;
      }
      if (this.bootstrapping) {
        return;
      }
      const ingested = await this.ingestRemoteCatalog(gen);
      if (!this.isGen(gen) || !ingested) {
        return;
      }
      this.outwardEnabled = true;
      this.flushBufferedLocal();
      await this.refreshLocals();
      if (this.allowAdopt) {
        await this.adoptUnmapped();
      }
      this.enqueueKnown();
      this.schedulePump(gen);
      await this.waitForWork(gen, { ignoreConnectivity: true });
    } finally {
      this.connectivityWork = Math.max(0, this.connectivityWork - 1);
      this.notifyIdle();
    }
  }

  private subscribeRemote(gen: number): void {
    this.unsubs.push(
      this.transport.subscribeLiveChildren((event) => {
        if (!this.isGen(gen)) {
          return;
        }
        this.onLiveEvent(event);
      }),
    );
    this.unsubs.push(
      this.transport.subscribeTombstones((event) => {
        if (!this.isGen(gen)) {
          return;
        }
        this.onTombstoneEvent(event);
      }),
    );
    if (this.transport.subscribeConnectivity) {
      this.unsubs.push(
        this.transport.subscribeConnectivity((connected) => {
          if (!this.isGen(gen)) {
            return;
          }
          void this.onConnectivityChange(connected, gen);
        }),
      );
    }
  }

  private subscribeLocal(gen: number): void {
    if (!this.adapter.subscribeLocalChanges) {
      return;
    }
    this.unsubs.push(
      this.adapter.subscribeLocalChanges((event) => {
        if (!this.isGen(gen)) {
          return;
        }
        if (!this.outwardEnabled) {
          this.bufferedLocal.push(event);
          return;
        }
        this.localEventsInFlight += 1;
        void this.handleLocalEvent(event)
          .catch(() => undefined)
          .finally(() => {
            this.localEventsInFlight -= 1;
            if (this.isGen(gen)) {
              this.schedulePump(gen);
              this.notifyIdle();
            }
          });
      }),
    );
  }

  private flushBufferedLocal(): void {
    const queued = this.bufferedLocal;
    this.bufferedLocal = [];
    for (const event of queued) {
      this.localEventsInFlight += 1;
      void this.handleLocalEvent(event)
        .catch(() => undefined)
        .finally(() => {
          this.localEventsInFlight -= 1;
          this.schedulePump(this.generation);
          this.notifyIdle();
        });
    }
  }

  private onLiveEvent(event: LiveChildEvent): void {
    if (event.type === 'removed') {
      this.live.delete(event.id);
      this.enqueue(event.id);
      this.schedulePump(this.generation);
      return;
    }
    const previous = this.live.get(event.id);
    this.live.set(event.id, event.value);
    if (
      event.type === 'added' &&
      previous &&
      previous.kind === 'v1' &&
      event.value.kind === 'v1' &&
      previous.record.revision === event.value.record.revision &&
      previous.record.updatedAt === event.value.record.updatedAt
    ) {
      return;
    }
    this.enqueue(event.id);
    this.schedulePump(this.generation);
  }

  private onTombstoneEvent(event: TombstoneEvent): void {
    if (event.type === 'removed') {
      this.tombstones.delete(event.id);
      this.enqueue(event.id);
      this.schedulePump(this.generation);
      return;
    }
    const previous = this.tombstones.get(event.id);
    this.tombstones.set(event.id, event.tombstone);
    if (
      previous &&
      previous.revision === event.tombstone.revision &&
      previous.deletedAt === event.tombstone.deletedAt
    ) {
      return;
    }
    this.enqueue(event.id);
    this.schedulePump(this.generation);
  }

  private async handleLocalEvent(event: LocalVaultEvent): Promise<void> {
    if (event.type === 'invalidated') {
      await this.refreshLocals();
      this.enqueueKnown();
      if (this.allowAdopt) {
        await this.adoptUnmapped();
      }
      this.schedulePump(this.generation);
      return;
    }

    await this.refreshLocals();

    if (event.type === 'renamed') {
      const entry = this.entryByLocalName(event.to) ?? this.entryByLocalName(event.from);
      if (entry) {
        this.markLanded(entry.id);
        await this.commitIndex((index) => {
          const next = cloneIndex(index);
          const current = next.entries[entry.id];
          if (current) {
            const child = this.locals.get(event.to);
            next.entries[entry.id] = {
              ...current,
              localName: event.to,
              identity: mergePlatformIdentity(current.identity, child, this.hashes.get(event.to)),
            };
          }
          return next;
        });
        this.enqueue(entry.id);
        this.schedulePump(this.generation);
        return;
      }
      if (this.allowAdopt) {
        await this.adoptName(event.to);
      }
      this.schedulePump(this.generation);
      return;
    }

    if (event.type === 'deleted') {
      const entry = this.entryByLocalName(event.name);
      if (entry) {
        this.enqueue(entry.id);
        this.schedulePump(this.generation);
      }
      return;
    }

    const mapped = this.entryByLocalName(event.name);
    if (mapped) {
      this.markLanded(mapped.id);
      this.hashes.delete(event.name);
      this.enqueue(mapped.id);
      this.schedulePump(this.generation);
      return;
    }
    if (this.allowAdopt) {
      await this.adoptName(event.name);
      this.schedulePump(this.generation);
    }
  }

  private enqueueKnown(): void {
    for (const id of collectKnownIds(this.index, this.live.keys(), this.tombstones.keys())) {
      this.enqueue(id);
    }
  }

  private async adoptUnmapped(): Promise<void> {
    if (!this.allowAdopt) {
      return;
    }
    for (const name of unmappedLocalNames([...this.locals.values()], this.index)) {
      await this.adoptName(name);
    }
  }

  private async adoptName(localName: string): Promise<void> {
    if (!this.allowAdopt || !this.locals.has(localName) || this.entryByLocalName(localName)) {
      return;
    }
    let adoptedId: string | null = null;
    try {
      await this.commitIndex((index) => {
        if (Object.values(index.entries).some((entry) => entry.localName === localName)) {
          return index;
        }
        const id = this.transport.allocateId();
        adoptedId = id;
        const next = cloneIndex(index);
        const child = this.locals.get(localName);
        next.entries[id] = {
          id,
          localName,
          identity: mergePlatformIdentity(undefined, child, this.hashes.get(localName)),
        };
        next.pendingOperations = replacePendingForId(next.pendingOperations, {
          kind: 'create',
          opId: newPendingOpId(),
          id,
          revision: newVaultRevision(),
          queuedAt: this.now(),
          state: 'queued',
          localName,
          preferredName: localName,
        });
        return next;
      });
      if (adoptedId) {
        this.log('adopt', 'mapped local file', { localName, id: adoptedId });
        this.markLanded(adoptedId);
        this.enqueue(adoptedId);
      }
    } catch (error) {
      this.errors.set(`local:${localName}`, errorMessage(error, 'Failed to adopt local file.'));
      this.emitSnapshot();
    }
  }

  private enqueue(id: string): void {
    this.dirty.add(id);
  }

  private schedulePump(gen: number): void {
    if (this.pumpScheduled || !this.isGen(gen)) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump(gen);
    });
  }

  private pump(gen: number): void {
    if (!this.isGen(gen)) {
      return;
    }
    for (const id of [...this.dirty]) {
      if (this.activeCount >= this.maxParallel) {
        break;
      }
      if (this.running.has(id)) {
        continue;
      }
      this.dirty.delete(id);
      this.running.add(id);
      this.activeCount += 1;
      void this.processId(id, gen)
        .catch((error) => {
          this.errors.set(id, errorMessage(error, 'Sync failed for this file.'));
        })
        .finally(() => {
          this.running.delete(id);
          this.activeCount = Math.max(0, this.activeCount - 1);
          if (this.isGen(gen)) {
            this.emitSnapshot();
            this.schedulePump(gen);
          }
          this.notifyIdle();
        });
    }
    this.notifyIdle();
  }

  private async processId(id: string, gen: number): Promise<void> {
    if (!this.isGen(gen)) {
      return;
    }
    try {
      let decision = decideReconcile(this.buildInput(id));
      if (decision.type === 'hash-local') {
        await this.hashLocalName(this.index.entries[id]?.localName);
        if (!this.isGen(gen)) {
          return;
        }
        decision = decideReconcile(this.buildInput(id));
      }
      this.log('pump', 'decision', {
        id,
        type: decision.type,
        connected: this.connected,
        remoteCatalogReady: this.remoteCatalogReady,
        outwardEnabled: this.outwardEnabled,
        pending: latestPendingForId(this.index.pendingOperations, id)?.kind ?? null,
      });
      await this.execute(id, decision, gen);
      if (!this.isGen(gen) || decision.type === 'ignore-invalid') {
        return;
      }
      const pending = latestPendingForId(this.index.pendingOperations, id);
      if (pending?.state !== 'failed') {
        this.errors.delete(id);
      }
    } catch (error) {
      if (!this.isGen(gen)) {
        return;
      }
      const message = errorMessage(error, 'Sync failed for this file.');
      this.errors.set(id, message);
      await this.markFailed(id, message);
    }
  }

  private buildInput(id: string): ReconcileInput {
    const indexEntry = this.index.entries[id] ?? null;
    const localName = indexEntry?.localName;
    const local = localName ? (this.locals.get(localName) ?? null) : null;
    const live = this.live.get(id) ?? null;
    return {
      id,
      local,
      localSha256: localName ? (this.hashes.get(localName) ?? null) : null,
      indexEntry,
      pending: latestPendingForId(this.index.pendingOperations, id),
      remoteRecord: live?.kind === 'v1' ? live.record : null,
      remoteLegacy: live?.kind === 'legacy',
      remoteInvalidReason: live?.kind === 'invalid' ? live.reason : null,
      tombstone: this.tombstones.get(id) ?? null,
      appliedTombstone: this.index.appliedTombstones[id] ?? null,
      occupiedNames: this.occupiedNames(),
      outwardEnabled: this.outwardEnabled,
      connected: this.connected,
      remoteCatalogReady: this.remoteCatalogReady,
      landedThisGeneration: this.landedThisGeneration.has(id),
      uniquifyOptions: this.uniquifyOptions,
    };
  }

  private occupiedNames(): string[] {
    return [...new Set([...this.locals.keys(), ...this.reservedNames])];
  }

  private async execute(
    id: string,
    decision: ReturnType<typeof decideReconcile>,
    gen: number,
  ): Promise<void> {
    switch (decision.type) {
      case 'noop':
      case 'hash-local':
        return;
      case 'reject-resurrection':
        await this.applyTombstone(id, gen);
        return;
      case 'ignore-invalid':
        this.errors.set(id, decision.reason);
        return;
      case 'migrate-legacy':
        await this.migrateLegacy(id, gen);
        return;
      case 'ack-pending':
        await this.ackRemote(id, decision.record, gen);
        return;
      case 'publish-pending':
        await this.publishPending(id, gen);
        return;
      case 'queue-create':
        await this.queueCreate(id);
        if (this.isGen(gen)) {
          await this.publishPending(id, gen);
        }
        return;
      case 'queue-update':
        await this.queueUpdate(id);
        if (this.isGen(gen)) {
          await this.publishPending(id, gen);
        }
        return;
      case 'queue-rename':
        await this.queueRename(id, decision.preferredName);
        if (this.isGen(gen)) {
          await this.publishPending(id, gen);
        }
        return;
      case 'queue-delete':
        await this.queueDelete(id);
        if (this.isGen(gen)) {
          await this.publishPending(id, gen);
        }
        return;
      case 'materialize-remote':
        await this.materializeRemote(id, decision.record, decision.targetName, gen);
        return;
      case 'rename-local':
        await this.applyRemoteName(id, decision.record, decision.targetName, gen);
        return;
      case 'apply-tombstone':
        await this.applyTombstone(id, gen);
        return;
      default: {
        const _never: never = decision;
        return _never;
      }
    }
  }

  private async migrateLegacy(id: string, gen: number): Promise<void> {
    const outcome = await this.transport.migrateLegacy(id);
    if (!this.isGen(gen)) {
      return;
    }
    if (outcome.outcome !== 'won') {
      this.errors.set(id, `Legacy migration failed (${outcome.outcome}).`);
      return;
    }
    this.live.set(id, { kind: 'v1', id, record: outcome.value });
    this.enqueue(id);
    this.schedulePump(gen);
  }

  private async ackRemote(id: string, record: RemoteFileRecord, gen: number): Promise<void> {
    const entry = this.index.entries[id];
    const localName =
      entry?.localName ??
      chooseLocalName(record.name, null, this.occupiedNames(), this.uniquifyOptions);
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = removePendingForId(next.pendingOperations, id);
      const current = next.entries[id] ?? { id, localName };
      next.entries[id] = {
        ...current,
        localName,
        appliedRemote: appliedFromRecord(record, record.name),
        identity: mergePlatformIdentity(
          current.identity,
          this.locals.get(localName),
          this.hashes.get(localName) ?? current.identity?.sha256,
        ),
      };
      delete next.appliedTombstones[id];
      return next;
    });
    if (!this.locals.has(localName)) {
      this.enqueue(id);
      this.schedulePump(gen);
    }
  }

  private async queueCreate(id: string): Promise<void> {
    const entry = this.index.entries[id];
    const localName = entry?.localName;
    if (!localName) {
      return;
    }
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = replacePendingForId(next.pendingOperations, {
        kind: 'create',
        opId: newPendingOpId(),
        id,
        revision: newVaultRevision(),
        queuedAt: this.now(),
        state: 'queued',
        localName,
        preferredName: localName,
      });
      return next;
    });
  }

  private async queueUpdate(id: string): Promise<void> {
    const entry = this.index.entries[id];
    const applied = entry?.appliedRemote;
    const localName = entry?.localName;
    if (!entry || !localName || !applied) {
      return;
    }
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = replacePendingForId(next.pendingOperations, {
        kind: 'update',
        opId: newPendingOpId(),
        id,
        revision: newVaultRevision(),
        queuedAt: this.now(),
        state: 'queued',
        expected: { updatedAt: applied.updatedAt, revision: applied.revision },
        localName,
      });
      return next;
    });
  }

  private async queueRename(id: string, preferredName: string): Promise<void> {
    const applied = this.index.entries[id]?.appliedRemote;
    if (!applied) {
      return;
    }
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = replacePendingForId(next.pendingOperations, {
        kind: 'rename',
        opId: newPendingOpId(),
        id,
        revision: newVaultRevision(),
        queuedAt: this.now(),
        state: 'queued',
        expected: { updatedAt: applied.updatedAt, revision: applied.revision },
        preferredName,
      });
      return next;
    });
  }

  private async queueDelete(id: string): Promise<void> {
    const applied = this.index.entries[id]?.appliedRemote;
    const live = this.v1Record(id);
    const expected = applied
      ? { updatedAt: applied.updatedAt, revision: applied.revision }
      : live
        ? clockFromRecord(live)
        : null;
    if (!expected) {
      await this.commitIndex((index) => {
        const next = cloneIndex(index);
        delete next.entries[id];
        next.pendingOperations = removePendingForId(next.pendingOperations, id);
        return next;
      });
      return;
    }
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = replacePendingForId(next.pendingOperations, {
        kind: 'delete',
        opId: newPendingOpId(),
        id,
        revision: newVaultRevision(),
        queuedAt: this.now(),
        state: 'queued',
        expected,
      });
      return next;
    });
  }

  private async publishPending(id: string, gen: number): Promise<void> {
    const pending = latestPendingForId(this.index.pendingOperations, id);
    if (!pending) {
      this.log('publish', 'skip — no pending op', { id });
      return;
    }
    if (!this.connected) {
      this.log('publish', 'skip — not connected', { id, kind: pending.kind });
      return;
    }
    this.log('publish', 'start', {
      id,
      kind: pending.kind,
      localName: 'localName' in pending ? pending.localName : undefined,
    });
    await this.setPendingState(pending.opId, 'in-flight');
    if (!this.isGen(gen)) {
      return;
    }

    try {
      if (pending.kind === 'delete') {
        await this.publishDelete(id, pending, gen);
        return;
      }
      if (pending.kind === 'rename') {
        await this.publishRename(id, pending, gen);
        return;
      }
      await this.publishBytes(id, pending, gen);
    } catch (error) {
      if (!this.isGen(gen)) {
        return;
      }
      const message = errorMessage(error, 'Cloud publish failed.');
      this.log('publish', 'failed', { id, error: message });
      this.errors.set(id, message);
      await this.setPendingState(pending.opId, 'failed', message);
    }
  }

  private async publishBytes(
    id: string,
    pending: PendingOperation & { kind: 'create' | 'update' },
    gen: number,
  ): Promise<void> {
    const localName = pending.localName;
    if (!this.locals.has(localName)) {
      throw new Error(`Local file is missing: ${localName}`);
    }
    const bytes = await this.adapter.readBytes(localName);
    if (!this.isGen(gen)) {
      return;
    }
    const sha256 = await sha256Hex(bytes);
    this.hashes.set(localName, sha256);
    const preferredName =
      pending.kind === 'create'
        ? pending.preferredName
        : (this.index.entries[id]?.appliedRemote?.preferredName ?? localName);
    const expectedClock = pending.kind === 'create' ? null : pending.expected;
    const applied = this.index.entries[id]?.appliedRemote;
    const outcome = await this.transport.commitBytes({
      id,
      name: preferredName,
      mimeType: mimeTypeFromName(preferredName),
      revision: pending.revision,
      expectedClock,
      bytes,
      previousBlobPath: applied?.blobPath,
    });
    if (!this.isGen(gen)) {
      return;
    }
    this.log('publish', 'commitBytes result', {
      id,
      outcome: outcome.outcome,
      reason: 'reason' in outcome ? outcome.reason : undefined,
      size: bytes.byteLength,
    });
    await this.handlePublishOutcome(id, pending.opId, outcome, gen);
  }

  private async publishRename(
    id: string,
    pending: PendingOperation & { kind: 'rename' },
    gen: number,
  ): Promise<void> {
    const outcome = await this.transport.renameRecord({
      id,
      expectedClock: pending.expected,
      name: pending.preferredName,
      revision: pending.revision,
    });
    if (!this.isGen(gen)) {
      return;
    }
    await this.handlePublishOutcome(id, pending.opId, outcome, gen);
  }

  private async publishDelete(
    id: string,
    pending: PendingOperation & { kind: 'delete' },
    gen: number,
  ): Promise<void> {
    const outcome = await this.transport.deleteRecord({
      id,
      expectedClock: pending.expected,
      revision: pending.revision,
    });
    if (!this.isGen(gen)) {
      return;
    }
    if (outcome.outcome === 'won') {
      this.live.delete(id);
      this.tombstones.set(id, outcome.value);
      await this.applyTombstone(id, gen);
      return;
    }
    // Only apply after a real remote tombstone (won above, or lost with current=tombstone).
    // lost/absent must keep the pending delete retryable — never drop the index without one.
    await this.handleLost(id, pending.opId, outcome, gen);
  }

  private async handlePublishOutcome(
    id: string,
    opId: string,
    outcome: Awaited<ReturnType<VaultTransport['commitBytes']>>,
    gen: number,
  ): Promise<void> {
    if (outcome.outcome === 'won') {
      this.live.set(id, { kind: 'v1', id, record: outcome.value });
      this.tombstones.delete(id);
      await this.ackRemote(id, outcome.value, gen);
      return;
    }
    await this.handleLost(id, opId, outcome, gen);
  }

  private async handleLost(
    id: string,
    opId: string,
    outcome: { outcome: 'lost' | 'rejected'; reason: string; current?: unknown },
    gen: number,
  ): Promise<void> {
    if (outcome.outcome === 'rejected') {
      this.errors.set(id, outcome.reason);
      await this.setPendingState(opId, 'failed', outcome.reason);
      return;
    }
    const current = 'current' in outcome ? outcome.current : null;
    if (current && typeof current === 'object' && current !== null && 'deletedAt' in current) {
      this.tombstones.set(id, current as RemoteTombstone);
      this.live.delete(id);
      await this.applyTombstone(id, gen);
      return;
    }
    if (current && typeof current === 'object' && current !== null && 'schemaVersion' in current) {
      const record = current as RemoteFileRecord;
      this.live.set(id, { kind: 'v1', id, record });
      await this.commitIndex((index) => {
        const next = cloneIndex(index);
        next.pendingOperations = removePendingForId(next.pendingOperations, id);
        return next;
      });
      this.enqueue(id);
      this.schedulePump(gen);
      return;
    }
    await this.setPendingState(opId, 'failed', `Publish lost (${outcome.reason}).`);
    this.errors.set(id, `Publish lost (${outcome.reason}).`);
    this.enqueue(id);
    this.schedulePump(gen);
  }

  private async materializeRemote(
    id: string,
    record: RemoteFileRecord,
    targetName: string,
    gen: number,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      if (record.content.kind === 'inline') {
        bytes = utf8Bytes(record.content.text);
      } else {
        bytes = await this.transport.downloadBlob(record.content.storagePath);
      }
    } catch (error) {
      throw new Error(`Missing blob: ${errorMessage(error, 'download failed')}`);
    }
    if (!this.isGen(gen)) {
      return;
    }
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== record.sha256) {
      throw new Error('Hash mismatch: downloaded bytes do not match remote sha256.');
    }
    if (bytes.byteLength !== record.size) {
      throw new Error('Size mismatch: downloaded bytes do not match remote size.');
    }

    const currentName = this.index.entries[id]?.localName ?? null;
    this.reservedNames.add(targetName);
    try {
      await this.expect({
        id,
        kind: 'write',
        name: targetName,
        sha256,
        size: record.size,
        revision: record.revision,
      });
      if (!this.isGen(gen)) {
        return;
      }
      await this.adapter.writeAtomic(targetName, bytes);
      this.hashes.set(targetName, sha256);
      const children = await this.adapter.listDirectChildren();
      const child = children.find((entry) => entry.name === targetName);
      this.locals.set(
        targetName,
        child ?? {
          name: targetName,
          size: bytes.byteLength,
          mtimeMs: this.now(),
        },
      );
      if (currentName && currentName !== targetName && this.locals.has(currentName)) {
        await this.expect({
          id,
          kind: 'delete',
          name: currentName,
          revision: record.revision,
        });
        if (this.isGen(gen)) {
          await this.adapter.remove(currentName);
          this.locals.delete(currentName);
          this.hashes.delete(currentName);
        }
      }
    } finally {
      this.reservedNames.delete(targetName);
    }

    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = removePendingForId(next.pendingOperations, id);
      const previous = next.entries[id];
      next.entries[id] = {
        id,
        localName: targetName,
        appliedRemote: appliedFromRecord(record),
        identity: mergePlatformIdentity(previous?.identity, this.locals.get(targetName), sha256),
      };
      delete next.appliedTombstones[id];
      return next;
    });
    this.markLanded(id);
  }

  private async applyRemoteName(
    id: string,
    record: RemoteFileRecord,
    targetName: string,
    gen: number,
  ): Promise<void> {
    const currentName = this.index.entries[id]?.localName ?? null;
    if (currentName && currentName !== targetName && this.locals.has(currentName)) {
      this.reservedNames.add(targetName);
      try {
        await this.expect({
          id,
          kind: 'rename',
          name: targetName,
          previousName: currentName,
          revision: record.revision,
        });
        if (!this.isGen(gen)) {
          return;
        }
        await this.adapter.rename(currentName, targetName);
        this.moveLocal(currentName, targetName);
      } finally {
        this.reservedNames.delete(targetName);
      }
    }
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      const previous = next.entries[id];
      next.entries[id] = {
        id,
        localName: targetName,
        appliedRemote: appliedFromRecord(record),
        identity: mergePlatformIdentity(
          previous?.identity,
          this.locals.get(targetName),
          this.hashes.get(targetName) ?? previous?.identity?.sha256,
        ),
      };
      next.pendingOperations = removePendingForId(next.pendingOperations, id);
      delete next.appliedTombstones[id];
      return next;
    });
    if (this.locals.has(targetName)) {
      this.markLanded(id);
    }
  }

  private async applyTombstone(id: string, gen: number): Promise<void> {
    const tombstone = this.tombstones.get(id);
    const applied = this.index.appliedTombstones[id];
    const persist = tombstone
      ? { deletedAt: tombstone.deletedAt, revision: tombstone.revision }
      : (applied ?? null);
    const localName = this.index.entries[id]?.localName;
    const expectRevision =
      persist?.revision ?? this.index.entries[id]?.appliedRemote?.revision ?? newVaultRevision();
    if (localName && this.locals.has(localName)) {
      await this.expect({
        id,
        kind: 'delete',
        name: localName,
        revision: expectRevision,
      });
      if (this.isGen(gen)) {
        try {
          await this.adapter.remove(localName);
        } catch {
          // file may already be gone
        }
        this.locals.delete(localName);
        this.hashes.delete(localName);
      }
    }
    this.live.delete(id);
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      delete next.entries[id];
      next.pendingOperations = removePendingForId(next.pendingOperations, id);
      if (persist) {
        next.appliedTombstones = {
          ...next.appliedTombstones,
          [id]: persist,
        };
      }
      return next;
    });
  }

  private async hashLocalName(localName: string | undefined): Promise<void> {
    if (!localName || !this.locals.has(localName) || this.hashes.has(localName)) {
      return;
    }
    const bytes = await this.adapter.readBytes(localName);
    this.hashes.set(localName, await sha256Hex(bytes));
  }

  private async refreshLocals(): Promise<void> {
    const previous = this.locals;
    const children = await this.adapter.listDirectChildren();
    this.locals = new Map(children.map((child) => [child.name, child]));
    for (const [name, child] of this.locals) {
      const prior = previous.get(name);
      if (!prior || prior.size !== child.size || prior.mtimeMs !== child.mtimeMs) {
        this.hashes.delete(name);
      }
    }
    for (const name of previous.keys()) {
      if (!this.locals.has(name)) {
        this.hashes.delete(name);
      }
    }
    this.markLandedFromScan();
    await this.persistLocalIdentities();
    this.emitSnapshot();
  }

  /** Mark IDs whose localName is present on disk as landed this generation. */
  private markLandedFromScan(): void {
    for (const entry of Object.values(this.index.entries)) {
      if (this.locals.has(entry.localName)) {
        this.markLanded(entry.id);
      }
    }
  }

  private markLanded(id: string): void {
    this.landedThisGeneration.add(id);
  }

  /** Copy adapter platform identity (dev/ino/size/mtime/hash) into index entries. */
  private async persistLocalIdentities(): Promise<void> {
    let dirty = false;
    for (const entry of Object.values(this.index.entries)) {
      const child = this.locals.get(entry.localName);
      if (!child) {
        continue;
      }
      const merged = mergePlatformIdentity(entry.identity, child, this.hashes.get(entry.localName));
      if (!platformIdentitiesEqual(entry.identity, merged)) {
        dirty = true;
        break;
      }
    }
    if (!dirty) {
      return;
    }
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      for (const [id, entry] of Object.entries(next.entries)) {
        const child = this.locals.get(entry.localName);
        if (!child) {
          continue;
        }
        const merged = mergePlatformIdentity(
          entry.identity,
          child,
          this.hashes.get(entry.localName),
        );
        if (!platformIdentitiesEqual(entry.identity, merged)) {
          next.entries[id] = { ...entry, identity: merged };
        }
      }
      return next;
    });
  }

  private moveLocal(from: string, to: string): void {
    const child = this.locals.get(from);
    if (child) {
      this.locals.delete(from);
      this.locals.set(to, { ...child, name: to });
    }
    const hash = this.hashes.get(from);
    if (hash) {
      this.hashes.delete(from);
      this.hashes.set(to, hash);
    }
  }

  private entryByLocalName(name: string): VaultIndexEntry | undefined {
    return Object.values(this.index.entries).find((entry) => entry.localName === name);
  }

  private v1Record(id: string): RemoteFileRecord | null {
    const live = this.live.get(id);
    return live?.kind === 'v1' ? live.record : null;
  }

  private async expect(effect: ExpectedLocalEffect): Promise<void> {
    await this.adapter.registerExpectedEffect?.(effect);
  }

  private async commitIndex(mutator: (index: VaultIndex) => VaultIndex): Promise<void> {
    const gen = this.generation;
    const run = this.persistChain.then(async () => {
      if (!this.isGen(gen)) {
        return;
      }
      this.index = mutator(this.index);
      await this.indexStore.saveIndex(this.index);
    });
    this.persistChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    if (this.isGen(gen)) {
      this.emitSnapshot();
    }
  }

  private async setPendingState(
    opId: string,
    state: PendingOpState,
    lastError?: string,
  ): Promise<void> {
    await this.commitIndex((index) => {
      const next = cloneIndex(index);
      next.pendingOperations = markPending(next.pendingOperations, opId, state, lastError);
      return next;
    });
  }

  private async markFailed(id: string, message: string): Promise<void> {
    const pending = latestPendingForId(this.index.pendingOperations, id);
    if (!pending) {
      return;
    }
    await this.setPendingState(pending.opId, 'failed', message);
  }

  private notifyIdle(): void {
    if (this.hasQueuedWork()) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private emitSnapshot(): void {
    this.latestSnapshot = this.buildSnapshot();
    const label = this.latestSnapshot.syncStatusLabel;
    if (this.debugLog && label !== this.lastDebugStatusLabel) {
      this.lastDebugStatusLabel = label;
      this.log('status', label, {
        connected: this.latestSnapshot.connected,
        bootstrapped: this.latestSnapshot.bootstrapped,
        remoteSyncing: this.remoteSyncing,
        remoteBootstrapComplete: this.remoteBootstrapComplete,
        remoteCatalogReady: this.remoteCatalogReady,
        catalogError: this.catalogError,
        rootStatus: this.latestSnapshot.rootStatus.kind,
      });
    }
    for (const listener of this.listeners) {
      listener(this.latestSnapshot);
    }
  }

  private buildSnapshot(): VaultSyncSnapshot {
    const entries: FileEntry[] = [];
    const seen = new Set<string>();
    const children = [...this.locals.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const mapped = this.entryByLocalName(child.name);
      const id = mapped?.id ?? `local:${child.name}`;
      seen.add(id);
      const pending = mapped ? latestPendingForId(this.index.pendingOperations, mapped.id) : null;
      const error = this.errors.get(id);
      const status: FileEntry['status'] = error
        ? 'error'
        : pending || !mapped || !mapped.appliedRemote
          ? 'pending'
          : 'ready';
      entries.push({
        id,
        localName: child.name,
        size: child.size,
        mtimeMs: child.mtimeMs,
        mimeType: mimeTypeFromName(child.name),
        sha256: this.hashes.get(child.name) ?? mapped?.identity?.sha256,
        preferredName: mapped?.appliedRemote?.preferredName,
        revision: mapped?.appliedRemote?.revision,
        updatedAt: mapped?.appliedRemote?.updatedAt,
        status,
        errorMessage: error,
      });
    }
    for (const [id, message] of this.errors) {
      if (seen.has(id)) {
        continue;
      }
      const entry = this.index.entries[id];
      const live = this.live.get(id);
      const localName = entry?.localName ?? (live?.kind === 'v1' ? live.record.name : id);
      entries.push({
        id,
        localName,
        size: 0,
        mtimeMs: 0,
        mimeType: mimeTypeFromName(localName),
        status: 'error',
        errorMessage: message,
      });
    }
    return {
      generation: this.generation,
      entries,
      initialLoading: this.bootstrapping,
      bootstrapped: this.bootstrapped,
      connected: this.connected,
      syncStatusLabel: this.buildSyncStatusLabel(),
      rootStatus: this.rootStatus,
      ownerUid: this.started ? this.transport.uid : null,
    };
  }
}

export type { VaultRootStatus, VaultSyncSnapshot } from './contracts';

export type VaultSyncCoordinatorOptions = VaultSyncOptions;
