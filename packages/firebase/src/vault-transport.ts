import {
  get,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
  push,
  ref,
  runTransaction,
  serverTimestamp,
  update,
} from 'firebase/database';
import type { DataSnapshot } from 'firebase/database';
import { deleteObject, getBytes, ref as storageRef, uploadBytes } from 'firebase/storage';
import {
  blobObjectPath,
  blobPathMatches,
  classifyFileContent,
  clockFromRecord,
  clocksEqual,
  INLINE_CONTENT_KIND,
  INLINE_ENCODING,
  isLegacyStorageItem,
  isSafeLocalName,
  isSha256Hex,
  isUuid,
  legacyMigrationRevision,
  migrateLegacyStorageItem,
  parseBlobObjectPath,
  parseLiveChild,
  parseRemoteFileRecord,
  parseRemoteTombstone,
  REMOTE_SCHEMA_VERSION,
  rtdbLivePath,
  rtdbLiveRoot,
  rtdbTombstonePath,
  rtdbTombstoneRoot,
  sha256Hex,
  utf8Bytes,
} from '@yard-1/vault';
import type {
  BlobUploadResult,
  CommitBytesInput,
  DeleteRecordInput,
  LegacyStorageItem,
  LiveChildEvent,
  LiveChildParse,
  MutationOutcome,
  PublishRecordInput,
  RemoteFileRecord,
  RemoteTombstone,
  RenameRecordInput,
  TombstoneEvent,
  Unsubscribe,
  VaultTransport,
} from '@yard-1/vault';

import { getFirebase, requireFirebaseStorage } from './init';

function snapshotKey(snap: DataSnapshot): string | null {
  return snap.key;
}

function mimeTypeLooksValid(value: string): boolean {
  return value.length >= 3 && value.length <= 255 && value.includes('/');
}

type ConflictCurrent = RemoteFileRecord | RemoteTombstone | LegacyStorageItem | null;

function lost(
  current: ConflictCurrent,
  reason: 'conflict' | 'tombstone' | 'absent',
): MutationOutcome<RemoteFileRecord> {
  return { outcome: 'lost', current, reason };
}

class FirebaseVaultTransport implements VaultTransport {
  constructor(readonly uid: string) {
    rtdbLiveRoot(uid);
  }

  allocateId(): string {
    const { db } = getFirebase();
    const idRef = push(ref(db, rtdbLiveRoot(this.uid)));
    if (!idRef.key) {
      throw new Error('Failed to allocate a Firebase push ID.');
    }
    return idRef.key;
  }

  async listLiveChildren(): Promise<LiveChildParse[]> {
    const { db } = getFirebase();
    const snap = await get(ref(db, rtdbLiveRoot(this.uid)));
    if (!snap.exists() || typeof snap.val() !== 'object' || snap.val() === null) {
      return [];
    }
    const children = snap.val() as Record<string, unknown>;
    return Object.entries(children).map(([id, value]) => parseLiveChild(id, value, this.uid));
  }

  async listTombstones(): Promise<Array<{ id: string; tombstone: RemoteTombstone }>> {
    const { db } = getFirebase();
    const snap = await get(ref(db, rtdbTombstoneRoot(this.uid)));
    if (!snap.exists() || typeof snap.val() !== 'object' || snap.val() === null) {
      return [];
    }
    const children = snap.val() as Record<string, unknown>;
    const out: Array<{ id: string; tombstone: RemoteTombstone }> = [];
    for (const [id, value] of Object.entries(children)) {
      const parsed = parseRemoteTombstone(value);
      if (parsed.ok) {
        out.push({ id, tombstone: parsed.value });
      }
    }
    return out;
  }

  async getLiveChild(id: string): Promise<LiveChildParse | null> {
    const { db } = getFirebase();
    const snap = await get(ref(db, rtdbLivePath(this.uid, id)));
    if (!snap.exists()) {
      return null;
    }
    return parseLiveChild(id, snap.val(), this.uid);
  }

  async getTombstone(id: string): Promise<RemoteTombstone | null> {
    const { db } = getFirebase();
    const snap = await get(ref(db, rtdbTombstonePath(this.uid, id)));
    if (!snap.exists()) {
      return null;
    }
    const parsed = parseRemoteTombstone(snap.val());
    return parsed.ok ? parsed.value : null;
  }

  subscribeLiveChildren(listener: (event: LiveChildEvent) => void): Unsubscribe {
    const { db } = getFirebase();
    const liveRef = ref(db, rtdbLiveRoot(this.uid));
    const emit = (type: 'added' | 'changed', snap: DataSnapshot) => {
      const id = snapshotKey(snap);
      if (!id) {
        return;
      }
      listener({ type, id, value: parseLiveChild(id, snap.val(), this.uid) });
    };
    const unsubAdded = onChildAdded(liveRef, (snap) => emit('added', snap));
    const unsubChanged = onChildChanged(liveRef, (snap) => emit('changed', snap));
    const unsubRemoved = onChildRemoved(liveRef, (snap) => {
      const id = snapshotKey(snap);
      if (id) {
        listener({ type: 'removed', id });
      }
    });
    return () => {
      unsubAdded();
      unsubChanged();
      unsubRemoved();
    };
  }

  subscribeTombstones(listener: (event: TombstoneEvent) => void): Unsubscribe {
    const { db } = getFirebase();
    const tombRef = ref(db, rtdbTombstoneRoot(this.uid));
    const emit = (type: 'added' | 'changed', snap: DataSnapshot) => {
      const id = snapshotKey(snap);
      if (!id) {
        return;
      }
      const parsed = parseRemoteTombstone(snap.val());
      if (parsed.ok) {
        listener({ type, id, tombstone: parsed.value });
      }
    };
    const unsubAdded = onChildAdded(tombRef, (snap) => emit('added', snap));
    const unsubChanged = onChildChanged(tombRef, (snap) => emit('changed', snap));
    const unsubRemoved = onChildRemoved(tombRef, (snap) => {
      const id = snapshotKey(snap);
      if (id) {
        listener({ type: 'removed', id });
      }
    });
    return () => {
      unsubAdded();
      unsubChanged();
      unsubRemoved();
    };
  }

  subscribeConnectivity(listener: (connected: boolean) => void): Unsubscribe {
    const { db } = getFirebase();
    const connectedRef = ref(db, '.info/connected');
    return onValue(connectedRef, (snap) => {
      listener(snap.val() === true);
    });
  }

  async uploadBlob(
    id: string,
    revision: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<BlobUploadResult> {
    const storage = requireFirebaseStorage();
    const storagePath = blobObjectPath(this.uid, id, revision);
    const objectRef = storageRef(storage, storagePath);
    await uploadBytes(objectRef, bytes, { contentType: mimeType });
    return {
      storagePath,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    };
  }

  async downloadBlob(storagePath: string): Promise<Uint8Array> {
    const parsed = parseBlobObjectPath(storagePath);
    if (!parsed || parsed.uid !== this.uid) {
      throw new Error('Blob storagePath does not belong to the current user.');
    }
    const storage = requireFirebaseStorage();
    const buffer = await getBytes(storageRef(storage, storagePath));
    return new Uint8Array(buffer);
  }

  async deleteBlob(storagePath: string): Promise<{ deleted: boolean }> {
    const parsed = parseBlobObjectPath(storagePath);
    if (!parsed || parsed.uid !== this.uid) {
      return { deleted: false };
    }
    try {
      const storage = requireFirebaseStorage();
      await deleteObject(storageRef(storage, storagePath));
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  }

  async publishRecord(input: PublishRecordInput): Promise<MutationOutcome<RemoteFileRecord>> {
    if (!isSafeLocalName(input.name)) {
      return { outcome: 'rejected', reason: 'Preferred name is not a safe filename.' };
    }
    if (!isUuid(input.revision)) {
      return { outcome: 'rejected', reason: 'Revision must be a UUID.' };
    }
    if (!mimeTypeLooksValid(input.mimeType)) {
      return { outcome: 'rejected', reason: 'mimeType is invalid.' };
    }

    let size: number;
    let sha256: string;
    let content: RemoteFileRecord['content'];

    if (input.content.kind === 'inline') {
      const bytes = utf8Bytes(input.content.text);
      const placement = classifyFileContent(bytes);
      if (placement.placement !== 'inline') {
        return { outcome: 'rejected', reason: 'Text is not eligible for inline storage.' };
      }
      size = bytes.byteLength;
      sha256 = await sha256Hex(bytes);
      content = { kind: INLINE_CONTENT_KIND, text: input.content.text, encoding: INLINE_ENCODING };
    } else {
      if (!blobPathMatches(input.content.storagePath, this.uid, input.id)) {
        return { outcome: 'rejected', reason: 'Blob storagePath does not match uid and id.' };
      }
      if (!isSha256Hex(input.content.sha256) || input.content.size < 0) {
        return { outcome: 'rejected', reason: 'Blob size or sha256 is invalid.' };
      }
      size = input.content.size;
      sha256 = input.content.sha256;
      content = { kind: 'blob', storagePath: input.content.storagePath };
    }

    const { db } = getFirebase();
    const recordRef = ref(db, rtdbLivePath(this.uid, input.id));
    const ctx = { uid: this.uid, id: input.id };

    const result = await runTransaction(recordRef, (current: unknown) => {
      if (input.expectedClock === null) {
        if (current !== null && current !== undefined) {
          return undefined;
        }
      } else {
        if (current === null || current === undefined || isLegacyStorageItem(current)) {
          return undefined;
        }
        const parsed = parseRemoteFileRecord(current, ctx);
        if (!parsed.ok || !clocksEqual(clockFromRecord(parsed.value), input.expectedClock)) {
          return undefined;
        }
      }

      const currentCreatedAt =
        typeof current === 'object' &&
        current !== null &&
        'createdAt' in current &&
        typeof (current as { createdAt: unknown }).createdAt === 'number'
          ? (current as { createdAt: number }).createdAt
          : undefined;

      return {
        schemaVersion: REMOTE_SCHEMA_VERSION,
        name: input.name,
        createdAt: currentCreatedAt ?? input.createdAt ?? serverTimestamp(),
        updatedAt: serverTimestamp(),
        size,
        mimeType: input.mimeType,
        sha256,
        revision: input.revision,
        content,
      };
    });

    if (!result.committed) {
      const current = await this.readConflictCurrent(input.id);
      const reason =
        current && 'deletedAt' in current ? 'tombstone' : current ? 'conflict' : 'absent';
      return lost(current, reason);
    }

    const parsed = await this.parseCommitted(input.id, result.snapshot.val());
    if (parsed.outcome !== 'won') {
      return parsed;
    }
    await this.clearTombstone(input.id);
    return parsed;
  }

  async commitBytes(input: CommitBytesInput): Promise<MutationOutcome<RemoteFileRecord>> {
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

    requireFirebaseStorage();
    let uploadedPath: string | null = null;
    try {
      const uploaded = await this.uploadBlob(input.id, input.revision, input.bytes, input.mimeType);
      uploadedPath = uploaded.storagePath;
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
      if (published.outcome === 'won') {
        if (input.previousBlobPath && input.previousBlobPath !== uploaded.storagePath) {
          await this.deleteBlob(input.previousBlobPath);
        }
      } else if (uploadedPath) {
        await this.deleteBlob(uploadedPath);
      }
      return published;
    } catch (error) {
      if (uploadedPath) {
        await this.deleteBlob(uploadedPath);
      }
      throw error;
    }
  }

  async renameRecord(input: RenameRecordInput): Promise<MutationOutcome<RemoteFileRecord>> {
    const current = await this.getLiveChild(input.id);
    if (!current) {
      const tombstone = await this.getTombstone(input.id);
      return lost(tombstone, tombstone ? 'tombstone' : 'absent');
    }
    if (current.kind !== 'v1') {
      return {
        outcome: 'rejected',
        reason:
          current.kind === 'legacy' ? 'Migrate legacy records before renaming.' : current.reason,
      };
    }
    if (!clocksEqual(clockFromRecord(current.record), input.expectedClock)) {
      return lost(current.record, 'conflict');
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

  async deleteRecord(input: DeleteRecordInput): Promise<MutationOutcome<RemoteTombstone>> {
    if (!isUuid(input.revision)) {
      return { outcome: 'rejected', reason: 'Revision must be a UUID.' };
    }

    const { db } = getFirebase();
    const recordRef = ref(db, rtdbLivePath(this.uid, input.id));
    const ctx = { uid: this.uid, id: input.id };
    let blobPath: string | undefined;
    let invalidReason: string | undefined;

    // CAS on the live path only — RTDB transactions cannot span storage + tombstones.
    const result = await runTransaction(
      recordRef,
      (current: unknown) => {
        blobPath = undefined;
        invalidReason = undefined;
        if (current === null || current === undefined) {
          return undefined;
        }
        if (isLegacyStorageItem(current)) {
          if (input.expectedClock.updatedAt !== current.createdAt) {
            return undefined;
          }
          return null;
        }
        const parsed = parseRemoteFileRecord(current, ctx);
        if (!parsed.ok) {
          invalidReason = parsed.error;
          return undefined;
        }
        if (!clocksEqual(clockFromRecord(parsed.value), input.expectedClock)) {
          return undefined;
        }
        if (parsed.value.content.kind === 'blob') {
          blobPath = parsed.value.content.storagePath;
        }
        return null;
      },
      { applyLocally: false },
    );

    if (!result.committed) {
      if (invalidReason) {
        return { outcome: 'rejected', reason: invalidReason };
      }
      const current = await this.readConflictCurrent(input.id);
      if (current && 'deletedAt' in current) {
        return { outcome: 'won', value: current };
      }
      if (current) {
        return { outcome: 'lost', current, reason: 'conflict' };
      }
      // Live already absent with no tombstone: finish the pending delete durably.
      const tombstone = await this.ensureTombstone(input.id, input.revision);
      return { outcome: 'won', value: tombstone };
    }

    // After CAS win, multi-location update reaffirms live removal + writes tombstone.
    // Retried until the tombstone is readable — delete is not acknowledged without it.
    const tombstone = await this.ensureTombstone(input.id, input.revision);

    if (blobPath) {
      await this.deleteBlob(blobPath);
    }

    return { outcome: 'won', value: tombstone };
  }

  /**
   * Write (or reaffirm) a tombstone via multi-location update with live:null.
   * Retries until the tombstone is readable so a network drop cannot leave a
   * live-absent / tombstone-missing hole for other devices.
   */
  private async ensureTombstone(id: string, revision: string): Promise<RemoteTombstone> {
    const { db } = getFirebase();
    const livePath = rtdbLivePath(this.uid, id);
    const tombPath = rtdbTombstonePath(this.uid, id);
    const maxAttempts = 8;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const existing = await this.getTombstone(id);
      if (existing) {
        return existing;
      }
      await update(ref(db), {
        [livePath]: null,
        [tombPath]: {
          deletedAt: serverTimestamp(),
          revision,
        },
      });
      const written = await this.getTombstone(id);
      if (written) {
        return written;
      }
    }

    throw new Error('Tombstone write did not resolve.');
  }

  async migrateLegacy(id: string): Promise<MutationOutcome<RemoteFileRecord>> {
    const current = await this.getLiveChild(id);
    if (!current) {
      return lost(null, 'absent');
    }
    if (current.kind === 'v1') {
      return { outcome: 'won', value: current.record };
    }
    if (current.kind === 'invalid') {
      return { outcome: 'rejected', reason: current.reason };
    }

    const item = current.item;
    const bytes = utf8Bytes(item.message);
    const placement = classifyFileContent(bytes);

    if (placement.placement === 'inline') {
      const migrated = await migrateLegacyStorageItem(id, item);
      return this.commitLegacyMigration(id, item, migrated);
    }

    requireFirebaseStorage();
    const revision = await legacyMigrationRevision(id, item);
    let uploadedPath: string | null = null;
    try {
      const uploaded = await this.uploadBlob(id, revision, bytes, 'text/plain');
      uploadedPath = uploaded.storagePath;
      const migrated = await migrateLegacyStorageItem(id, item, uploaded.storagePath);
      const outcome = await this.commitLegacyMigration(id, item, migrated);
      if (outcome.outcome !== 'won' && uploadedPath) {
        await this.deleteBlob(uploadedPath);
      }
      return outcome;
    } catch (error) {
      if (uploadedPath) {
        await this.deleteBlob(uploadedPath);
      }
      throw error;
    }
  }

  private async commitLegacyMigration(
    id: string,
    item: LegacyStorageItem,
    migrated: RemoteFileRecord,
  ): Promise<MutationOutcome<RemoteFileRecord>> {
    const { db } = getFirebase();
    const recordRef = ref(db, rtdbLivePath(this.uid, id));
    const ctx = { uid: this.uid, id };

    const result = await runTransaction(recordRef, (live: unknown) => {
      if (live === null || live === undefined) {
        return undefined;
      }
      if (isLegacyStorageItem(live)) {
        if (live.createdAt === item.createdAt && live.message === item.message) {
          return migrated;
        }
        return undefined;
      }
      const parsed = parseRemoteFileRecord(live, ctx);
      if (parsed.ok) {
        return live;
      }
      return undefined;
    });

    if (!result.committed) {
      const latest = await this.getLiveChild(id);
      return lost(
        latest?.kind === 'v1' ? latest.record : latest?.kind === 'legacy' ? latest.item : null,
        'conflict',
      );
    }

    return this.parseCommitted(id, result.snapshot.val());
  }

  private async parseCommitted(
    id: string,
    raw: unknown,
  ): Promise<MutationOutcome<RemoteFileRecord>> {
    const parsed = parseRemoteFileRecord(raw, { uid: this.uid, id });
    if (!parsed.ok) {
      const fresh = await this.getLiveChild(id);
      if (fresh?.kind === 'v1') {
        return { outcome: 'won', value: fresh.record };
      }
      return { outcome: 'rejected', reason: parsed.error };
    }
    return { outcome: 'won', value: parsed.value };
  }

  private async readConflictCurrent(
    id: string,
  ): Promise<RemoteFileRecord | RemoteTombstone | LegacyStorageItem | null> {
    const live = await this.getLiveChild(id);
    if (live?.kind === 'v1') {
      return live.record;
    }
    if (live?.kind === 'legacy') {
      return live.item;
    }
    return this.getTombstone(id);
  }

  private async clearTombstone(id: string): Promise<void> {
    const { db } = getFirebase();
    await update(ref(db), { [rtdbTombstonePath(this.uid, id)]: null });
  }
}

export function createFirebaseVaultTransport(uid: string): VaultTransport {
  return new FirebaseVaultTransport(uid);
}
