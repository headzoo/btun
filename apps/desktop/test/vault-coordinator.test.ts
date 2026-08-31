import { describe, expect, it } from 'vitest';
import {
  VaultSyncCoordinator,
  blobObjectPath,
  classifyFileContent,
  clocksEqual,
  clockFromRecord,
  createEmptyVaultIndex,
  INLINE_TEXT_MAX_CHARS,
  mimeTypeFromName,
  newVaultRevision,
  parseLiveChild,
  sha256Hex,
  utf8Bytes,
  type DirectChildSnapshot,
  type ExpectedLocalEffect,
  type IndexedVaultAdapter,
  type LiveChildEvent,
  type LiveChildParse,
  type LocalVaultEvent,
  type MutationOutcome,
  type RemoteFileRecord,
  type RemoteTombstone,
  type TombstoneEvent,
  type Unsubscribe,
  type VaultIndex,
  type VaultIndexLoadResult,
  type VaultTransport,
} from '@yard-1/vault';

const uid = 'userUid1';

class MemoryAdapter implements IndexedVaultAdapter {
  files = new Map<
    string,
    { bytes: Uint8Array; mtimeMs: number; identity?: { dev: string; ino: string } }
  >();
  index: VaultIndex;
  private expected: ExpectedLocalEffect[] = [];
  private readonly listeners = new Set<(event: LocalVaultEvent) => void>();
  private clock = 1;
  private nextIno = 100;

  constructor(ownerUid = uid) {
    this.index = createEmptyVaultIndex(ownerUid);
  }

  async loadIndex(): Promise<VaultIndexLoadResult> {
    return { status: 'ok', index: structuredClone(this.index) };
  }

  async saveIndex(index: VaultIndex): Promise<void> {
    this.index = structuredClone(index);
  }

  async listDirectChildren(): Promise<DirectChildSnapshot[]> {
    return [...this.files.entries()].map(([name, file]) => ({
      name,
      size: file.bytes.byteLength,
      mtimeMs: file.mtimeMs,
      identity: file.identity,
    }));
  }

  async readBytes(name: string): Promise<Uint8Array> {
    const file = this.files.get(name);
    if (!file) {
      throw new Error(`Missing ${name}`);
    }
    return file.bytes;
  }

  async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    const existed = this.files.has(name);
    const prior = this.files.get(name);
    this.files.set(name, {
      bytes,
      mtimeMs: ++this.clock,
      identity: prior?.identity ?? { dev: 'mem', ino: String(++this.nextIno) },
    });
    const event: LocalVaultEvent = { type: existed ? 'changed' : 'created', name };
    if (!this.consume(event)) {
      this.emit(event);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) {
      throw new Error(`Missing ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, file);
    const event: LocalVaultEvent = { type: 'renamed', from, to };
    if (!this.consume(event)) {
      this.emit(event);
    }
  }

  async remove(name: string): Promise<void> {
    if (!this.files.has(name)) {
      throw new Error(`Missing ${name}`);
    }
    this.files.delete(name);
    const event: LocalVaultEvent = { type: 'deleted', name };
    if (!this.consume(event)) {
      this.emit(event);
    }
  }

  registerExpectedEffect(effect: ExpectedLocalEffect): void {
    this.expected.push(effect);
  }

  subscribeLocalChanges(listener: (event: LocalVaultEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  addFile(name: string, bytes: Uint8Array, identity?: { dev: string; ino: string }): void {
    this.files.set(name, {
      bytes,
      mtimeMs: ++this.clock,
      identity: identity ?? { dev: 'mem', ino: String(++this.nextIno) },
    });
    this.emit({ type: 'created', name });
  }

  private emit(event: LocalVaultEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private consume(event: LocalVaultEvent): boolean {
    const index = this.expected.findIndex((effect) => {
      if (event.type === 'deleted') {
        return effect.kind === 'delete' && effect.name === event.name;
      }
      if (event.type === 'renamed') {
        return (
          effect.kind === 'rename' && effect.previousName === event.from && effect.name === event.to
        );
      }
      if (event.type === 'created' || event.type === 'changed') {
        return (effect.kind === 'write' || effect.kind === 'rename') && effect.name === event.name;
      }
      return false;
    });
    if (index < 0) {
      return false;
    }
    this.expected.splice(index, 1);
    return true;
  }
}

class MemoryRemote {
  live = new Map<string, LiveChildParse>();
  tombstones = new Map<string, RemoteTombstone>();
  blobs = new Map<string, Uint8Array>();
  liveListeners = new Set<(event: LiveChildEvent) => void>();
  tombListeners = new Set<(event: TombstoneEvent) => void>();
  connectivityListeners = new Set<(connected: boolean) => void>();
  listShouldFail = false;
  connected = true;
  clock = 1000;
  nextId = 0;
  /** Artificial download latency for slow-materialize race tests. */
  downloadDelayMs = 0;
  downloadWaiters = 0;
  /** When true, downloadBlob throws (failed rematerialize tests). */
  downloadShouldFail = false;
  private downloadGate: Promise<void> | null = null;
  private releaseDownloadGate: (() => void) | null = null;

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  allocateId(): string {
    this.nextId += 1;
    return `-M${String(this.nextId).padStart(10, '0')}`;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const listener of this.connectivityListeners) {
      listener(connected);
    }
  }

  /** Hold downloads until releaseDownloads() — for mid-ingest local-create tests. */
  holdDownloads(): void {
    this.downloadGate = new Promise<void>((resolve) => {
      this.releaseDownloadGate = resolve;
    });
  }

  releaseDownloads(): void {
    this.releaseDownloadGate?.();
    this.releaseDownloadGate = null;
    this.downloadGate = null;
  }
}

class MemoryTransport implements VaultTransport {
  constructor(
    readonly uid: string,
    protected readonly remote: MemoryRemote,
  ) {}

  allocateId(): string {
    return this.remote.allocateId();
  }

  async listLiveChildren(): Promise<LiveChildParse[]> {
    if (this.remote.listShouldFail) {
      throw new Error('Remote catalog unavailable.');
    }
    return [...this.remote.live.values()];
  }

  async listTombstones(): Promise<Array<{ id: string; tombstone: RemoteTombstone }>> {
    if (this.remote.listShouldFail) {
      throw new Error('Remote catalog unavailable.');
    }
    return [...this.remote.tombstones.entries()].map(([id, tombstone]) => ({ id, tombstone }));
  }

  async getLiveChild(id: string): Promise<LiveChildParse | null> {
    return this.remote.live.get(id) ?? null;
  }

  async getTombstone(id: string): Promise<RemoteTombstone | null> {
    return this.remote.tombstones.get(id) ?? null;
  }

  subscribeLiveChildren(listener: (event: LiveChildEvent) => void): Unsubscribe {
    this.remote.liveListeners.add(listener);
    return () => {
      this.remote.liveListeners.delete(listener);
    };
  }

  subscribeTombstones(listener: (event: TombstoneEvent) => void): Unsubscribe {
    this.remote.tombListeners.add(listener);
    return () => {
      this.remote.tombListeners.delete(listener);
    };
  }

  subscribeConnectivity(listener: (connected: boolean) => void): Unsubscribe {
    this.remote.connectivityListeners.add(listener);
    return () => {
      this.remote.connectivityListeners.delete(listener);
    };
  }

  async uploadBlob(
    id: string,
    revision: string,
    bytes: Uint8Array,
    _mimeType: string,
  ): Promise<{ storagePath: string; size: number; sha256: string }> {
    const storagePath = blobObjectPath(this.uid, id, revision);
    this.remote.blobs.set(storagePath, bytes);
    return { storagePath, size: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }

  async downloadBlob(storagePath: string): Promise<Uint8Array> {
    if (this.remote.downloadGate) {
      this.remote.downloadWaiters += 1;
      try {
        await this.remote.downloadGate;
      } finally {
        this.remote.downloadWaiters -= 1;
      }
    }
    if (this.remote.downloadDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.remote.downloadDelayMs));
    }
    if (this.remote.downloadShouldFail) {
      throw new Error(`Simulated download failure for ${storagePath}`);
    }
    const bytes = this.remote.blobs.get(storagePath);
    if (!bytes) {
      throw new Error(`Missing blob ${storagePath}`);
    }
    return bytes;
  }

  async deleteBlob(storagePath: string): Promise<{ deleted: boolean }> {
    return { deleted: this.remote.blobs.delete(storagePath) };
  }

  async publishRecord(input: {
    id: string;
    name: string;
    mimeType: string;
    revision: string;
    expectedClock: { updatedAt: number; revision: string } | null;
    content:
      | { kind: 'inline'; text: string }
      | { kind: 'blob'; storagePath: string; size: number; sha256: string };
  }): Promise<MutationOutcome<RemoteFileRecord>> {
    const current = this.remote.live.get(input.id);
    if (input.expectedClock === null && current) {
      return {
        outcome: 'lost',
        current: current.kind === 'v1' ? current.record : null,
        reason: 'conflict',
      };
    }
    if (input.expectedClock && current?.kind === 'v1') {
      if (!clocksEqual(clockFromRecord(current.record), input.expectedClock)) {
        return { outcome: 'lost', current: current.record, reason: 'conflict' };
      }
    }
    if (input.expectedClock && !current) {
      const tombstone = this.remote.tombstones.get(input.id);
      return {
        outcome: 'lost',
        current: tombstone ?? null,
        reason: tombstone ? 'tombstone' : 'absent',
      };
    }

    let size: number;
    let sha256: string;
    let content: RemoteFileRecord['content'];
    if (input.content.kind === 'inline') {
      const bytes = utf8Bytes(input.content.text);
      size = bytes.byteLength;
      sha256 = await sha256Hex(bytes);
      content = { kind: 'inline', text: input.content.text, encoding: 'utf-8' };
    } else {
      size = input.content.size;
      sha256 = input.content.sha256;
      content = { kind: 'blob', storagePath: input.content.storagePath };
    }

    const createdAt = current?.kind === 'v1' ? current.record.createdAt : this.remote.tick();
    const value: RemoteFileRecord = {
      schemaVersion: 1,
      name: input.name,
      createdAt,
      updatedAt: this.remote.tick(),
      size,
      mimeType: input.mimeType,
      sha256,
      revision: input.revision,
      content,
    };
    const parsed = parseLiveChild(input.id, value, this.uid);
    this.remote.live.set(input.id, parsed);
    this.remote.tombstones.delete(input.id);
    this.emitLive({ type: current ? 'changed' : 'added', id: input.id, value: parsed });
    return { outcome: 'won', value };
  }

  async commitBytes(input: {
    id: string;
    name: string;
    mimeType: string;
    revision: string;
    expectedClock: { updatedAt: number; revision: string } | null;
    bytes: Uint8Array;
    previousBlobPath?: string | null;
  }): Promise<MutationOutcome<RemoteFileRecord>> {
    const placement = classifyFileContent(input.bytes);
    if (placement.placement === 'inline') {
      return this.publishRecord({
        id: input.id,
        name: input.name,
        mimeType: input.mimeType,
        revision: input.revision,
        expectedClock: input.expectedClock,
        content: { kind: 'inline', text: placement.text },
      });
    }
    const uploaded = await this.uploadBlob(input.id, input.revision, input.bytes, input.mimeType);
    const published = await this.publishRecord({
      id: input.id,
      name: input.name,
      mimeType: input.mimeType,
      revision: input.revision,
      expectedClock: input.expectedClock,
      content: {
        kind: 'blob',
        storagePath: uploaded.storagePath,
        size: uploaded.size,
        sha256: uploaded.sha256,
      },
    });
    if (published.outcome === 'won' && input.previousBlobPath) {
      await this.deleteBlob(input.previousBlobPath);
    }
    return published;
  }

  async renameRecord(input: {
    id: string;
    expectedClock: { updatedAt: number; revision: string };
    name: string;
    revision: string;
  }): Promise<MutationOutcome<RemoteFileRecord>> {
    const current = this.remote.live.get(input.id);
    if (current?.kind !== 'v1') {
      return { outcome: 'lost', current: null, reason: 'absent' };
    }
    const record = current.record;
    if (record.content.kind === 'inline') {
      return this.publishRecord({
        id: input.id,
        name: input.name,
        mimeType: record.mimeType,
        revision: input.revision,
        expectedClock: input.expectedClock,
        content: { kind: 'inline', text: record.content.text },
      });
    }
    return this.publishRecord({
      id: input.id,
      name: input.name,
      mimeType: record.mimeType,
      revision: input.revision,
      expectedClock: input.expectedClock,
      content: {
        kind: 'blob',
        storagePath: record.content.storagePath,
        size: record.size,
        sha256: record.sha256,
      },
    });
  }

  async deleteRecord(input: {
    id: string;
    expectedClock: { updatedAt: number; revision: string };
    revision: string;
  }): Promise<MutationOutcome<RemoteTombstone>> {
    const current = this.remote.live.get(input.id);
    if (!current) {
      const existing = this.remote.tombstones.get(input.id);
      if (existing) {
        return { outcome: 'won', value: existing };
      }
      // Live already absent: write tombstone for the pending delete (durable protocol).
      const tombstone = this.writeTombstone(input.id, input.revision);
      return { outcome: 'won', value: tombstone };
    }
    if (
      current.kind === 'v1' &&
      !clocksEqual(clockFromRecord(current.record), input.expectedClock)
    ) {
      return { outcome: 'lost', current: current.record, reason: 'conflict' };
    }
    if (current.kind === 'legacy' && input.expectedClock.updatedAt !== current.item.createdAt) {
      return { outcome: 'lost', current: current.item, reason: 'conflict' };
    }
    this.remote.live.delete(input.id);
    this.emitLive({ type: 'removed', id: input.id });
    const tombstone = this.writeTombstone(input.id, input.revision);
    if (current.kind === 'v1' && current.record.content.kind === 'blob') {
      await this.deleteBlob(current.record.content.storagePath);
    }
    return { outcome: 'won', value: tombstone };
  }

  protected writeTombstone(id: string, revision: string): RemoteTombstone {
    const tombstone: RemoteTombstone = {
      deletedAt: this.remote.tick(),
      revision,
    };
    this.remote.tombstones.set(id, tombstone);
    for (const listener of this.remote.tombListeners) {
      listener({ type: 'added', id, tombstone });
    }
    return tombstone;
  }

  async migrateLegacy(): Promise<MutationOutcome<RemoteFileRecord>> {
    return { outcome: 'rejected', reason: 'no legacy records in memory transport' };
  }

  protected emitLive(event: LiveChildEvent): void {
    for (const listener of this.remote.liveListeners) {
      listener(event);
    }
  }
}

async function startPair(): Promise<{
  remote: MemoryRemote;
  a: MemoryAdapter;
  b: MemoryAdapter;
  ca: VaultSyncCoordinator;
  cb: VaultSyncCoordinator;
}> {
  const remote = new MemoryRemote();
  const a = new MemoryAdapter();
  const b = new MemoryAdapter();
  const ca = new VaultSyncCoordinator({
    adapter: a,
    transport: new MemoryTransport(uid, remote),
  });
  const cb = new VaultSyncCoordinator({
    adapter: b,
    transport: new MemoryTransport(uid, remote),
  });
  await ca.start();
  await cb.start();
  await ca.waitForIdle();
  await cb.waitForIdle();
  return { remote, a, b, ca, cb };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

describe('VaultSyncCoordinator', () => {
  it('converges create, edit, rename, and delete across two clients', async () => {
    const { a, b, ca, cb, remote } = await startPair();

    a.addFile('hello.txt', utf8Bytes('hello'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    expect([...b.files.keys()]).toEqual(['hello.txt']);
    expect(new TextDecoder().decode(b.files.get('hello.txt')?.bytes)).toBe('hello');

    const id = Object.keys(a.index.entries)[0]!;
    const firstRevision = remote.live.get(id);
    expect(firstRevision?.kind).toBe('v1');

    await a.writeAtomic('hello.txt', utf8Bytes('hello world'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    expect(new TextDecoder().decode(b.files.get('hello.txt')?.bytes)).toBe('hello world');

    await ca.commands.rename(id, 'greetings.txt');
    await cb.waitForIdle();
    expect([...b.files.keys()]).toEqual(['greetings.txt']);
    expect(remote.live.get(id)?.kind === 'v1' && remote.live.get(id)?.record.name).toBe(
      'greetings.txt',
    );

    await ca.commands.remove(id);
    await cb.waitForIdle();
    expect(b.files.size).toBe(0);
    expect(remote.live.has(id)).toBe(false);
    expect(remote.tombstones.has(id)).toBe(true);

    await ca.stop();
    await cb.stop();
  });

  it('uniquifies duplicate preferred names per device and keeps files ready only after materialize', async () => {
    const { a, b, ca, cb } = await startPair();
    b.addFile('Report.pdf', utf8Bytes('local'));
    await cb.waitForIdle();

    a.addFile('Report.pdf', utf8Bytes('from-a'));
    await ca.waitForIdle();
    await cb.waitForIdle();

    expect(b.files.has('Report.pdf')).toBe(true);
    expect(b.files.has('Report.2.pdf')).toBe(true);
    const snapshot = cb.getSnapshot();
    expect(snapshot.entries.every((entry) => entry.localName !== undefined)).toBe(true);
    expect(snapshot.entries.find((entry) => entry.localName === 'Report.2.pdf')?.status).not.toBe(
      'missing',
    );

    await ca.stop();
    await cb.stop();
  });

  it('does not publish an echo revision after materializing a remote write', async () => {
    const { a, ca, cb, remote } = await startPair();
    a.addFile('echo.txt', utf8Bytes('payload'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    const before = remote.live.get(id);
    expect(before?.kind).toBe('v1');
    const after = remote.live.get(id);
    expect(after?.kind).toBe('v1');
    if (before?.kind === 'v1' && after?.kind === 'v1') {
      expect(after.record.revision).toBe(before.record.revision);
      expect(after.record.updatedAt).toBe(before.record.updatedAt);
    }
    await ca.stop();
    await cb.stop();
  });

  it('persists platform identity and rebinds offline renames to the same id', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const identity = { dev: 'disk', ino: '42' };
    adapter.addFile('report.txt', utf8Bytes('body'), identity);
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();

    const id = Object.keys(adapter.index.entries)[0]!;
    expect(adapter.index.entries[id]?.identity?.dev).toBe('disk');
    expect(adapter.index.entries[id]?.identity?.ino).toBe('42');
    await coordinator.stop();

    const file = adapter.files.get('report.txt');
    expect(file).toBeTruthy();
    adapter.files.delete('report.txt');
    adapter.files.set('renamed-offline.txt', {
      bytes: file!.bytes,
      mtimeMs: file!.mtimeMs,
      identity,
    });
    // Index still points at the old name but keeps durable identity.
    expect(adapter.index.entries[id]?.localName).toBe('report.txt');

    const restarted = new VaultSyncCoordinator({
      adapter,
      transport: new MemoryTransport(uid, remote),
    });
    await restarted.start();
    await restarted.waitForIdle();

    // Same sync identity retained (no second create), even if preferred-name
    // reconcile later restores the remote name onto disk.
    expect(Object.keys(adapter.index.entries)).toEqual([id]);
    expect(adapter.files.size).toBe(1);
    expect(remote.live.has(id)).toBe(true);
    expect(remote.live.size).toBe(1);
    await restarted.stop();
  });

  it('publishes a same-size local edit after a cloud materialize', async () => {
    const { a, b, ca, cb, remote } = await startPair();
    a.addFile('same-size.txt', utf8Bytes('aaaa'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    const before = remote.live.get(id);
    expect(before?.kind).toBe('v1');
    if (before?.kind !== 'v1') {
      return;
    }

    // Local edit with identical byte length must publish a new revision.
    await b.writeAtomic('same-size.txt', utf8Bytes('bbbb'));
    await cb.waitForIdle();
    await ca.waitForIdle();

    const after = remote.live.get(id);
    expect(after?.kind).toBe('v1');
    if (after?.kind === 'v1') {
      expect(after.record.revision).not.toBe(before.record.revision);
      if (after.record.content.kind === 'inline') {
        expect(after.record.content.text).toBe('bbbb');
      }
    }
    await ca.stop();
    await cb.stop();
  });

  it('keeps pending creates across restart and finishes them', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const id = '-Mpending01';
    const revision = newVaultRevision();
    adapter.files.set('pending.txt', { bytes: utf8Bytes('queued'), mtimeMs: 1 });
    adapter.index.entries[id] = { id, localName: 'pending.txt' };
    adapter.index.pendingOperations = [
      {
        kind: 'create',
        opId: 'op-restart',
        id,
        revision,
        queuedAt: Date.now(),
        state: 'in-flight',
        localName: 'pending.txt',
        preferredName: 'pending.txt',
      },
    ];
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    const live = remote.live.get(id);
    expect(live?.kind).toBe('v1');
    if (live?.kind === 'v1' && live.record.content.kind === 'inline') {
      expect(live.record.content.text).toBe('queued');
    }
    expect(adapter.index.pendingOperations).toHaveLength(0);
    await coordinator.stop();
  });

  it('applies a remote tombstone over a stale offline pending update', async () => {
    const { a, ca, remote } = await startPair();
    a.addFile('gone.txt', utf8Bytes('x'));
    await ca.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    const live = remote.live.get(id);
    expect(live?.kind).toBe('v1');
    if (live?.kind !== 'v1') {
      return;
    }

    await ca.stop();
    a.index.pendingOperations = [
      {
        kind: 'update',
        opId: 'stale',
        id,
        revision: newVaultRevision(),
        queuedAt: Date.now(),
        state: 'queued',
        expected: clockFromRecord(live.record),
        localName: 'gone.txt',
      },
    ];
    await a.writeAtomic('gone.txt', utf8Bytes('offline-edit'));

    const other = new MemoryAdapter();
    const otherCoordinator = new VaultSyncCoordinator({
      adapter: other,
      transport: new MemoryTransport(uid, remote),
    });
    await otherCoordinator.start();
    await otherCoordinator.commands.remove(id);
    await otherCoordinator.waitForIdle();
    await otherCoordinator.stop();

    const restarted = new VaultSyncCoordinator({
      adapter: a,
      transport: new MemoryTransport(uid, remote),
    });
    await restarted.start();
    await restarted.waitForIdle();
    expect(a.files.has('gone.txt')).toBe(false);
    expect(remote.live.has(id)).toBe(false);
    await restarted.stop();
  });

  it('isolates a malformed remote record so other ids still sync', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const badId = '-M0000000001';
    remote.live.set(badId, {
      kind: 'invalid',
      id: badId,
      reason: 'Remote file record is missing required fields.',
    });
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    adapter.addFile('ok.txt', utf8Bytes('ok'));
    await coordinator.waitForIdle();
    expect(Object.keys(adapter.index.entries).length).toBeGreaterThan(0);
    const snapshot = coordinator.getSnapshot();
    expect(snapshot.entries.some((entry) => entry.localName === 'ok.txt')).toBe(true);
    await coordinator.stop();
  });

  it('surfaces hash mismatch without blocking unrelated files', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const id = '-M0000000002';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('real-bytes');
    const record: RemoteFileRecord = {
      schemaVersion: 1,
      name: 'bad.bin',
      createdAt: 1,
      updatedAt: 2,
      size: bytes.byteLength,
      mimeType: mimeTypeFromName('bad.bin'),
      sha256: 'c'.repeat(64),
      revision,
      content: { kind: 'blob', storagePath: blobObjectPath(uid, id, revision) },
    };
    remote.blobs.set(record.content.kind === 'blob' ? record.content.storagePath : '', bytes);
    remote.live.set(id, { kind: 'v1', id, record });

    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    const snapshot = coordinator.getSnapshot();
    expect(snapshot.entries.some((entry) => entry.status === 'error')).toBe(true);
    adapter.addFile('fine.txt', utf8Bytes('fine'));
    await coordinator.waitForIdle();
    expect(adapter.files.has('fine.txt')).toBe(true);
    await coordinator.stop();
  });

  it('transitions inline text to a blob when it exceeds the inline threshold', async () => {
    const { a, b, ca, cb, remote } = await startPair();
    a.addFile('big.txt', utf8Bytes('small'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    await a.writeAtomic('big.txt', utf8Bytes('x'.repeat(INLINE_TEXT_MAX_CHARS + 8)));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const live = remote.live.get(id);
    expect(live?.kind).toBe('v1');
    if (live?.kind === 'v1') {
      expect(live.record.content.kind).toBe('blob');
    }
    expect(b.files.get('big.txt')?.bytes.byteLength).toBe(INLINE_TEXT_MAX_CHARS + 8);
    await ca.stop();
    await cb.stop();
  });

  it('transitions a blob back to inline when content shrinks below the threshold', async () => {
    const { a, b, ca, cb, remote } = await startPair();
    a.addFile('shrink.txt', utf8Bytes('x'.repeat(INLINE_TEXT_MAX_CHARS + 8)));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    const blobLive = remote.live.get(id);
    expect(blobLive?.kind).toBe('v1');
    if (blobLive?.kind === 'v1') {
      expect(blobLive.record.content.kind).toBe('blob');
    }

    await a.writeAtomic('shrink.txt', utf8Bytes('tiny'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const inlineLive = remote.live.get(id);
    expect(inlineLive?.kind).toBe('v1');
    if (inlineLive?.kind === 'v1') {
      expect(inlineLive.record.content.kind).toBe('inline');
      if (inlineLive.record.content.kind === 'inline') {
        expect(inlineLive.record.content.text).toBe('tiny');
      }
    }
    expect(new TextDecoder().decode(b.files.get('shrink.txt')?.bytes)).toBe('tiny');
    await ca.stop();
    await cb.stop();
  });

  it('ignores late work after stop/generation change', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const coordinator = new VaultSyncCoordinator({
      adapter,
      transport: new MemoryTransport(uid, remote),
    });
    await coordinator.start();
    const generation = coordinator.getSnapshot().generation;
    await coordinator.stop();
    adapter.addFile('late.txt', utf8Bytes('nope'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remote.live.size).toBe(0);
    expect(coordinator.getSnapshot().generation).not.toBe(generation);
    expect(coordinator.getSnapshot().rootStatus).toEqual({ kind: 'idle' });
  });

  it('converges after competing local edits so both clients match the remote winner', async () => {
    const { a, b, ca, cb, remote } = await startPair();
    a.addFile('race.txt', utf8Bytes('start'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;

    await Promise.all([
      a.writeAtomic('race.txt', utf8Bytes('from-a')),
      b.writeAtomic('race.txt', utf8Bytes('from-b')),
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await ca.waitForIdle();
      await cb.waitForIdle();
      const live = remote.live.get(id);
      if (live?.kind !== 'v1' || live.record.content.kind !== 'inline') {
        continue;
      }
      const winner = live.record.content.text;
      const aText = new TextDecoder().decode(a.files.get('race.txt')?.bytes);
      const bText = new TextDecoder().decode(b.files.get('race.txt')?.bytes);
      if (aText === winner && bText === winner) {
        expect(['from-a', 'from-b']).toContain(winner);
        await ca.stop();
        await cb.stop();
        return;
      }
    }
    throw new Error('Clients did not converge to the remote winner.');
  });

  it('breaks equal updatedAt ties by revision ordering', async () => {
    const older = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(
      clocksEqual({ updatedAt: 10, revision: older }, { updatedAt: 10, revision: newer }),
    ).toBe(false);
  });

  it('leaves a blob uploaded when metadata publish fails', async () => {
    class FailPublishTransport extends MemoryTransport {
      override async publishRecord(): Promise<MutationOutcome<RemoteFileRecord>> {
        throw new Error('metadata publish failed');
      }
    }

    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new FailPublishTransport(uid, remote);
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    adapter.addFile('blob.bin', new Uint8Array([0, 1, 2, 3]));
    await coordinator.waitForIdle();
    expect(remote.live.size).toBe(0);
    expect(remote.blobs.size).toBeGreaterThan(0);
    expect(adapter.index.pendingOperations.some((op) => op.state === 'failed')).toBe(true);
    await coordinator.stop();
  });

  it('finishes a pending rename op after restart', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const id = '-Mrestart02';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('rename-me');
    const record: RemoteFileRecord = {
      schemaVersion: 1,
      name: 'old.txt',
      createdAt: 1,
      updatedAt: 2,
      size: bytes.byteLength,
      mimeType: 'text/plain',
      sha256: await sha256Hex(bytes),
      revision,
      content: { kind: 'inline', text: 'rename-me', encoding: 'utf-8' },
    };
    remote.live.set(id, { kind: 'v1', id, record });
    adapter.files.set('old.txt', { bytes, mtimeMs: 1 });
    adapter.index.entries[id] = {
      id,
      localName: 'old.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: record.sha256,
        size: record.size,
        preferredName: 'old.txt',
      },
    };
    adapter.index.pendingOperations = [
      {
        kind: 'rename',
        opId: 'op-rename',
        id,
        revision: newVaultRevision(),
        queuedAt: 3,
        state: 'in-flight',
        expected: clockFromRecord(record),
        preferredName: 'new.txt',
      },
    ];

    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    const live = remote.live.get(id);
    expect(live?.kind).toBe('v1');
    if (live?.kind === 'v1') {
      expect(live.record.name).toBe('new.txt');
    }
    expect(adapter.index.pendingOperations).toHaveLength(0);
    await coordinator.stop();
  });

  it('finishes a pending delete op after restart', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const id = '-Mrestart01';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('keep');
    const record: RemoteFileRecord = {
      schemaVersion: 1,
      name: 'keep.txt',
      createdAt: 1,
      updatedAt: 2,
      size: bytes.byteLength,
      mimeType: 'text/plain',
      sha256: await sha256Hex(bytes),
      revision,
      content: { kind: 'inline', text: 'keep', encoding: 'utf-8' },
    };
    remote.live.set(id, { kind: 'v1', id, record });
    adapter.files.set('keep.txt', { bytes, mtimeMs: 1 });
    adapter.index.entries[id] = {
      id,
      localName: 'keep.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: record.sha256,
        size: record.size,
        preferredName: 'keep.txt',
      },
    };
    adapter.index.pendingOperations = [
      {
        kind: 'delete',
        opId: 'op-delete',
        id,
        revision: newVaultRevision(),
        queuedAt: 3,
        state: 'in-flight',
        expected: clockFromRecord(record),
      },
    ];

    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    expect(adapter.files.has('keep.txt')).toBe(false);
    expect(remote.tombstones.has(id)).toBe(true);
    expect(adapter.index.pendingOperations).toHaveLength(0);
    await coordinator.stop();
  });

  it('does not tombstone or adopt while the remote catalog list fails, then recovers on reconnect', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);

    const mappedId = '-Mmapped001';
    const remoteOnlyId = '-Mremote002';
    const mappedRevision = newVaultRevision();
    const remoteRevision = newVaultRevision();
    const mappedBytes = utf8Bytes('mapped-remote');
    const remoteBytes = utf8Bytes('from-cloud');
    const mappedHash = await sha256Hex(mappedBytes);
    const remoteHash = await sha256Hex(remoteBytes);

    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'mapped.txt',
        createdAt: 1,
        updatedAt: 2,
        size: mappedBytes.byteLength,
        mimeType: 'text/plain',
        sha256: mappedHash,
        revision: mappedRevision,
        content: { kind: 'inline', text: 'mapped-remote', encoding: 'utf-8' },
      },
    });
    remote.live.set(remoteOnlyId, {
      kind: 'v1',
      id: remoteOnlyId,
      record: {
        schemaVersion: 1,
        name: 'cloud.txt',
        createdAt: 3,
        updatedAt: 4,
        size: remoteBytes.byteLength,
        mimeType: 'text/plain',
        sha256: remoteHash,
        revision: remoteRevision,
        content: { kind: 'inline', text: 'from-cloud', encoding: 'utf-8' },
      },
    });

    // Mapped index entry with no local file, plus an unmapped local import.
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'mapped.txt',
      appliedRemote: {
        revision: mappedRevision,
        updatedAt: 2,
        sha256: mappedHash,
        size: mappedBytes.byteLength,
        preferredName: 'mapped.txt',
      },
    };
    adapter.files.set('unmapped.txt', { bytes: utf8Bytes('local-only'), mtimeMs: 1 });

    remote.listShouldFail = true;
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();

    expect(adapter.files.has('unmapped.txt')).toBe(true);
    expect(adapter.files.has('mapped.txt')).toBe(false);
    expect(adapter.files.has('cloud.txt')).toBe(false);
    expect(Object.keys(adapter.index.entries)).toEqual([mappedId]);
    expect(adapter.index.appliedTombstones[mappedId]).toBeUndefined();
    expect(adapter.index.pendingOperations).toHaveLength(0);

    remote.listShouldFail = false;
    remote.setConnected(false);
    remote.setConnected(true);
    await coordinator.waitForIdle();

    expect(adapter.files.has('mapped.txt')).toBe(true);
    expect(adapter.files.has('cloud.txt')).toBe(true);
    expect(adapter.files.has('unmapped.txt')).toBe(true);
    expect(
      Object.values(adapter.index.entries).some((entry) => entry.localName === 'unmapped.txt'),
    ).toBe(true);
    expect(remote.live.size).toBeGreaterThanOrEqual(3);

    await coordinator.commands.refresh();
    await coordinator.waitForIdle();
    expect(adapter.files.has('unmapped.txt')).toBe(true);
    expect(
      Object.values(adapter.index.entries).some((entry) => entry.localName === 'unmapped.txt'),
    ).toBe(true);

    await coordinator.stop();
  });

  it('does not tombstone indexed remotes when materialize exceeds the old 8s ingest window', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const mappedId = '-MslowMat01';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('slow-cloud-bytes');
    const hash = await sha256Hex(bytes);
    const storagePath = blobObjectPath(uid, mappedId, revision);

    remote.blobs.set(storagePath, bytes);
    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'slow.txt',
        createdAt: 1,
        updatedAt: 2,
        size: bytes.byteLength,
        mimeType: 'text/plain',
        sha256: hash,
        revision,
        content: { kind: 'blob', storagePath },
      },
    });
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'slow.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: hash,
        size: bytes.byteLength,
        preferredName: 'slow.txt',
      },
    };

    // Past the previous throwing 8s waitForWork cap used by ingestRemoteCatalog.
    remote.downloadDelayMs = 8500;

    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle(20_000);

    expect(adapter.files.has('slow.txt')).toBe(true);
    expect(new TextDecoder().decode(adapter.files.get('slow.txt')?.bytes)).toBe('slow-cloud-bytes');
    expect(remote.tombstones.has(mappedId)).toBe(false);
    expect(adapter.index.appliedTombstones[mappedId]).toBeUndefined();
    expect(remote.live.has(mappedId)).toBe(true);
    expect(adapter.index.pendingOperations.some((op) => op.kind === 'delete')).toBe(false);

    await coordinator.stop();
  }, 25_000);

  it('adopts a local create that arrives during reconnect catalog ingest', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const mappedId = '-Mreconnect1';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('existing-remote');
    const hash = await sha256Hex(bytes);
    const storagePath = blobObjectPath(uid, mappedId, revision);

    remote.blobs.set(storagePath, bytes);
    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'mapped.txt',
        createdAt: 1,
        updatedAt: 2,
        size: bytes.byteLength,
        mimeType: 'text/plain',
        sha256: hash,
        revision,
        content: { kind: 'blob', storagePath },
      },
    });
    adapter.files.set('mapped.txt', { bytes, mtimeMs: 1 });
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'mapped.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: hash,
        size: bytes.byteLength,
        preferredName: 'mapped.txt',
      },
    };

    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    expect(adapter.files.has('mapped.txt')).toBe(true);

    // Add a second remote that must materialize on reconnect; hold its download
    // so reconnect ingest keeps outwardEnabled off long enough to buffer a create.
    const remoteOnlyId = '-Mreconnect2';
    const remoteRevision = newVaultRevision();
    const remoteBytes = utf8Bytes('new-from-cloud');
    const remoteHash = await sha256Hex(remoteBytes);
    const remotePath = blobObjectPath(uid, remoteOnlyId, remoteRevision);
    remote.blobs.set(remotePath, remoteBytes);
    remote.live.set(remoteOnlyId, {
      kind: 'v1',
      id: remoteOnlyId,
      record: {
        schemaVersion: 1,
        name: 'cloud-new.txt',
        createdAt: 3,
        updatedAt: 4,
        size: remoteBytes.byteLength,
        mimeType: 'text/plain',
        sha256: remoteHash,
        revision: remoteRevision,
        content: { kind: 'blob', storagePath: remotePath },
      },
    });

    remote.holdDownloads();
    remote.setConnected(false);
    remote.setConnected(true);

    const waitedUntilHeld = await waitUntil(() => remote.downloadWaiters > 0, 5000);
    expect(waitedUntilHeld).toBe(true);
    adapter.addFile('during-ingest.txt', utf8Bytes('finder-drop'));

    remote.releaseDownloads();
    await coordinator.waitForIdle();

    expect(adapter.files.has('during-ingest.txt')).toBe(true);
    expect(adapter.files.has('cloud-new.txt')).toBe(true);
    expect(
      Object.values(adapter.index.entries).some((entry) => entry.localName === 'during-ingest.txt'),
    ).toBe(true);
    expect(
      [...remote.live.values()].some(
        (child) =>
          child.kind === 'v1' &&
          child.record.name === 'during-ingest.txt' &&
          child.record.content.kind === 'inline' &&
          child.record.content.text === 'finder-drop',
      ),
    ).toBe(true);
    expect(remote.tombstones.has(mappedId)).toBe(false);
    expect(remote.tombstones.has(remoteOnlyId)).toBe(false);

    await coordinator.stop();
  });

  it('rematerializes after a failed catalog list once refresh succeeds', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const mappedId = '-Mrefresh01';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('cloud-bytes');
    const hash = await sha256Hex(bytes);
    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'mapped.txt',
        createdAt: 1,
        updatedAt: 2,
        size: bytes.byteLength,
        mimeType: 'text/plain',
        sha256: hash,
        revision,
        content: { kind: 'inline', text: 'cloud-bytes', encoding: 'utf-8' },
      },
    });
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'mapped.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: hash,
        size: bytes.byteLength,
        preferredName: 'mapped.txt',
      },
    };

    remote.listShouldFail = true;
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    expect(adapter.files.has('mapped.txt')).toBe(false);
    expect(adapter.index.appliedTombstones[mappedId]).toBeUndefined();
    expect(adapter.index.entries[mappedId]).toBeDefined();

    remote.listShouldFail = false;
    await coordinator.commands.refresh();
    expect(adapter.files.has('mapped.txt')).toBe(true);
    expect(new TextDecoder().decode(adapter.files.get('mapped.txt')?.bytes)).toBe('cloud-bytes');
    expect(adapter.index.appliedTombstones[mappedId]).toBeUndefined();
    await coordinator.stop();
  });

  it('applies a winning tombstone instead of republishing a pending create', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const id = '-McreateGone';
    const tombRevision = newVaultRevision();
    adapter.files.set('resurrect.txt', { bytes: utf8Bytes('nope'), mtimeMs: 1 });
    adapter.index.entries[id] = { id, localName: 'resurrect.txt' };
    adapter.index.pendingOperations = [
      {
        kind: 'create',
        opId: 'op-create',
        id,
        revision: newVaultRevision(),
        queuedAt: 1,
        state: 'queued',
        localName: 'resurrect.txt',
        preferredName: 'resurrect.txt',
      },
    ];
    remote.tombstones.set(id, { deletedAt: 50, revision: tombRevision });

    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    expect(remote.live.has(id)).toBe(false);
    expect(adapter.files.has('resurrect.txt')).toBe(false);
    expect(remote.tombstones.get(id)?.revision).toBe(tombRevision);
    expect(adapter.index.appliedTombstones[id]?.revision).toBe(tombRevision);
    await coordinator.stop();
  });

  it('loses a stale delete when the live clock is newer', async () => {
    const { a, ca, cb, remote } = await startPair();
    a.addFile('keep.txt', utf8Bytes('v1'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    const live = remote.live.get(id);
    expect(live?.kind).toBe('v1');
    if (live?.kind !== 'v1') {
      await ca.stop();
      await cb.stop();
      return;
    }
    const staleClock = clockFromRecord(live.record);

    await a.writeAtomic('keep.txt', utf8Bytes('v2'));
    await ca.waitForIdle();
    await cb.waitForIdle();

    const transport = new MemoryTransport(uid, remote);
    const outcome = await transport.deleteRecord({
      id,
      expectedClock: staleClock,
      revision: newVaultRevision(),
    });
    expect(outcome.outcome).toBe('lost');
    expect(remote.live.has(id)).toBe(true);
    expect(new TextDecoder().decode(a.files.get('keep.txt')?.bytes)).toBe('v2');
    await ca.stop();
    await cb.stop();
  });

  it('retries delete after live removal when the tombstone write fails once', async () => {
    class SplitDeleteTransport extends MemoryTransport {
      failTombstoneOnce = true;

      override async deleteRecord(input: {
        id: string;
        expectedClock: { updatedAt: number; revision: string };
        revision: string;
      }): Promise<MutationOutcome<RemoteTombstone>> {
        const current = this.remote.live.get(input.id);
        if (!current) {
          const existing = this.remote.tombstones.get(input.id);
          if (existing) {
            return { outcome: 'won', value: existing };
          }
          // Recovery path after a prior split: finish the tombstone.
          const tombstone = this.writeTombstone(input.id, input.revision);
          return { outcome: 'won', value: tombstone };
        }
        if (
          current.kind === 'v1' &&
          !clocksEqual(clockFromRecord(current.record), input.expectedClock)
        ) {
          return { outcome: 'lost', current: current.record, reason: 'conflict' };
        }
        // Simulate network drop between live CAS removal and tombstone write.
        // Live is gone on the remote, but do not fan out the removal event so the
        // coordinator does not auto-republish before the test can assert the hole.
        this.remote.live.delete(input.id);
        if (this.failTombstoneOnce) {
          this.failTombstoneOnce = false;
          throw new Error('tombstone write failed');
        }
        this.emitLive({ type: 'removed', id: input.id });
        const tombstone = this.writeTombstone(input.id, input.revision);
        if (current.kind === 'v1' && current.record.content.kind === 'blob') {
          await this.deleteBlob(current.record.content.storagePath);
        }
        return { outcome: 'won', value: tombstone };
      }
    }

    const remote = new MemoryRemote();
    const a = new MemoryAdapter();
    const b = new MemoryAdapter();
    const flaky = new SplitDeleteTransport(uid, remote);
    const ca = new VaultSyncCoordinator({ adapter: a, transport: flaky });
    const cb = new VaultSyncCoordinator({
      adapter: b,
      transport: new MemoryTransport(uid, remote),
    });
    await ca.start();
    await cb.start();
    await ca.waitForIdle();
    await cb.waitForIdle();

    a.addFile('split.txt', utf8Bytes('payload'));
    await ca.waitForIdle();
    await cb.waitForIdle();
    const id = Object.keys(a.index.entries)[0]!;
    expect(b.files.has('split.txt')).toBe(true);

    await ca.commands.remove(id);
    await ca.waitForIdle();

    // Live gone, tombstone missing, pending delete still retryable — no fake applied tombstone.
    expect(remote.live.has(id)).toBe(false);
    expect(remote.tombstones.has(id)).toBe(false);
    expect(a.index.appliedTombstones[id]).toBeUndefined();
    expect(a.index.pendingOperations.some((op) => op.kind === 'delete')).toBe(true);
    // Other client still has the file until a real tombstone lands.
    expect(b.files.has('split.txt')).toBe(true);

    await ca.retry(id);
    await ca.waitForIdle();
    await cb.waitForIdle();

    expect(remote.tombstones.has(id)).toBe(true);
    expect(a.index.appliedTombstones[id]?.revision).toBe(remote.tombstones.get(id)?.revision);
    expect(a.index.pendingOperations).toHaveLength(0);
    expect(b.files.has('split.txt')).toBe(false);

    await ca.stop();
    await cb.stop();
  });

  it('keeps a live remote after failed rematerialize, then materializes on retry', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const mappedId = '-MfailMat01';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('cloud-payload');
    const hash = await sha256Hex(bytes);
    const storagePath = blobObjectPath(uid, mappedId, revision);

    remote.blobs.set(storagePath, bytes);
    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'missing-local.txt',
        createdAt: 1,
        updatedAt: 2,
        size: bytes.byteLength,
        mimeType: 'text/plain',
        sha256: hash,
        revision,
        content: { kind: 'blob', storagePath },
      },
    });
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'missing-local.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: hash,
        size: bytes.byteLength,
        preferredName: 'missing-local.txt',
        blobPath: storagePath,
      },
    };

    remote.downloadShouldFail = true;
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();

    expect(adapter.files.has('missing-local.txt')).toBe(false);
    expect(remote.live.has(mappedId)).toBe(true);
    expect(remote.tombstones.has(mappedId)).toBe(false);
    expect(adapter.index.appliedTombstones[mappedId]).toBeUndefined();
    expect(adapter.index.pendingOperations.some((op) => op.kind === 'delete')).toBe(false);
    expect(adapter.index.entries[mappedId]?.appliedRemote?.revision).toBe(revision);
    expect(coordinator.getSnapshot().entries.some((entry) => entry.id === mappedId)).toBe(true);
    expect(coordinator.getSnapshot().entries.find((entry) => entry.id === mappedId)?.status).toBe(
      'error',
    );

    remote.downloadShouldFail = false;
    await coordinator.retry(mappedId);
    await coordinator.waitForIdle();

    expect(adapter.files.has('missing-local.txt')).toBe(true);
    expect(new TextDecoder().decode(adapter.files.get('missing-local.txt')?.bytes)).toBe(
      'cloud-payload',
    );
    expect(remote.live.has(mappedId)).toBe(true);
    expect(remote.tombstones.has(mappedId)).toBe(false);
    expect(adapter.index.pendingOperations.some((op) => op.kind === 'delete')).toBe(false);

    await coordinator.stop();
  });

  it('tombstones a post-landing local delete even after a prior failed rematerialize', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const mappedId = '-MlandDel01';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('land-then-delete');
    const hash = await sha256Hex(bytes);
    const storagePath = blobObjectPath(uid, mappedId, revision);

    remote.blobs.set(storagePath, bytes);
    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'landed.txt',
        createdAt: 1,
        updatedAt: 2,
        size: bytes.byteLength,
        mimeType: 'text/plain',
        sha256: hash,
        revision,
        content: { kind: 'blob', storagePath },
      },
    });
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'landed.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: hash,
        size: bytes.byteLength,
        preferredName: 'landed.txt',
        blobPath: storagePath,
      },
    };

    remote.downloadShouldFail = true;
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    expect(remote.live.has(mappedId)).toBe(true);
    expect(remote.tombstones.has(mappedId)).toBe(false);

    remote.downloadShouldFail = false;
    await coordinator.retry(mappedId);
    await coordinator.waitForIdle();
    expect(adapter.files.has('landed.txt')).toBe(true);

    await adapter.remove('landed.txt');
    await coordinator.waitForIdle();

    expect(remote.live.has(mappedId)).toBe(false);
    expect(remote.tombstones.has(mappedId)).toBe(true);
    expect(adapter.index.appliedTombstones[mappedId]).toBeDefined();
    expect(adapter.files.has('landed.txt')).toBe(false);

    await coordinator.stop();
  });

  it('explicit remove tombstones a never-landed indexed remote', async () => {
    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new MemoryTransport(uid, remote);
    const mappedId = '-MexplDel01';
    const revision = newVaultRevision();
    const bytes = utf8Bytes('explicit-delete');
    const hash = await sha256Hex(bytes);
    const storagePath = blobObjectPath(uid, mappedId, revision);

    remote.blobs.set(storagePath, bytes);
    remote.live.set(mappedId, {
      kind: 'v1',
      id: mappedId,
      record: {
        schemaVersion: 1,
        name: 'never-landed.txt',
        createdAt: 1,
        updatedAt: 2,
        size: bytes.byteLength,
        mimeType: 'text/plain',
        sha256: hash,
        revision,
        content: { kind: 'blob', storagePath },
      },
    });
    adapter.index.entries[mappedId] = {
      id: mappedId,
      localName: 'never-landed.txt',
      appliedRemote: {
        revision,
        updatedAt: 2,
        sha256: hash,
        size: bytes.byteLength,
        preferredName: 'never-landed.txt',
        blobPath: storagePath,
      },
    };

    remote.downloadShouldFail = true;
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    await coordinator.waitForIdle();
    expect(adapter.files.has('never-landed.txt')).toBe(false);
    expect(remote.live.has(mappedId)).toBe(true);

    await coordinator.commands.remove(mappedId);
    await coordinator.waitForIdle();

    expect(remote.live.has(mappedId)).toBe(false);
    expect(remote.tombstones.has(mappedId)).toBe(true);
    expect(adapter.index.appliedTombstones[mappedId]).toBeDefined();
    expect(adapter.index.entries[mappedId]).toBeUndefined();

    await coordinator.stop();
  });

  it('isolates a thrown publish so other ids still upload and connected stays true', async () => {
    class FlakyPublishTransport extends MemoryTransport {
      override async commitBytes(input: {
        id: string;
        name: string;
        mimeType: string;
        revision: string;
        expectedClock: { updatedAt: number; revision: string } | null;
        bytes: Uint8Array;
        previousBlobPath?: string | null;
      }): Promise<MutationOutcome<RemoteFileRecord>> {
        if (input.name === 'bad.txt') {
          throw new Error('isolated publish failure');
        }
        return super.commitBytes(input);
      }
    }

    const remote = new MemoryRemote();
    const adapter = new MemoryAdapter();
    const transport = new FlakyPublishTransport(uid, remote);
    const coordinator = new VaultSyncCoordinator({ adapter, transport });
    await coordinator.start();
    adapter.addFile('bad.txt', utf8Bytes('bad'));
    adapter.addFile('good.txt', utf8Bytes('good'));
    await coordinator.waitForIdle();
    expect(coordinator.getSnapshot().connected).toBe(true);
    expect(
      [...remote.live.values()].some(
        (child) => child.kind === 'v1' && child.record.name === 'good.txt',
      ),
    ).toBe(true);
    expect(
      [...remote.live.values()].some(
        (child) => child.kind === 'v1' && child.record.name === 'bad.txt',
      ),
    ).toBe(false);
    expect(adapter.index.pendingOperations.some((op) => op.state === 'failed')).toBe(true);
    await coordinator.stop();
  });
});
