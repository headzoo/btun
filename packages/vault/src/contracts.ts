import type { VaultIndex, VaultIndexLoadResult } from './index-schema';
import type {
  FileEntry,
  LegacyStorageItem,
  RemoteClock,
  RemoteFileRecord,
  RemoteTombstone,
} from './model';
import type { LiveChildParse } from './parse';

export type Unsubscribe = () => void;

export interface VaultError {
  code:
    | 'not-found'
    | 'not-a-file'
    | 'path-escape'
    | 'unsafe-name'
    | 'owner-mismatch'
    | 'permission'
    | 'unsupported'
    | 'conflict'
    | 'storage-unconfigured'
    | 'io';
  message: string;
}

export type VaultResult<T> = { ok: true; value: T } | { ok: false; error: VaultError };

export interface DirectChildSnapshot {
  name: string;
  size: number;
  mtimeMs: number;
  identity?: {
    dev?: string;
    ino?: string;
  };
}

export interface ExpectedLocalEffect {
  id: string;
  kind: 'write' | 'rename' | 'delete';
  name?: string;
  previousName?: string;
  sha256?: string;
  size?: number;
  revision: string;
}

export type LocalVaultEvent =
  | { type: 'created' | 'changed'; name: string }
  | { type: 'deleted'; name: string }
  | { type: 'renamed'; from: string; to: string }
  | { type: 'invalidated' };

export interface VaultAdapter {
  listDirectChildren(): Promise<DirectChildSnapshot[]>;
  readBytes(name: string): Promise<Uint8Array>;
  writeAtomic(name: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  registerExpectedEffect?(effect: ExpectedLocalEffect): void | Promise<void>;
  subscribeLocalChanges?(listener: (event: LocalVaultEvent) => void): Unsubscribe;
}

/** Durable hidden-index persistence used by the sync coordinator. */
export interface VaultIndexStore {
  loadIndex(): Promise<VaultIndexLoadResult>;
  saveIndex(index: VaultIndex): Promise<void>;
}

export type IndexedVaultAdapter = VaultAdapter & VaultIndexStore;

export type VaultRootStatus =
  | { kind: 'idle' }
  | { kind: 'ready' }
  | { kind: 'owner-mismatch'; ownerUid?: string; message: string }
  | { kind: 'permission'; message: string }
  | { kind: 'error'; message: string };

/** Observable coordinator snapshot. The file list is local materialization, not RTDB. */
export interface VaultSyncSnapshot {
  generation: number;
  entries: FileEntry[];
  initialLoading: boolean;
  bootstrapped: boolean;
  connected: boolean;
  /** Short status line for UI (online/offline/reason). */
  syncStatusLabel: string;
  rootStatus: VaultRootStatus;
  ownerUid: string | null;
}

export type LiveChildEvent =
  | { type: 'added' | 'changed'; id: string; value: LiveChildParse }
  | { type: 'removed'; id: string };

export type TombstoneEvent =
  | { type: 'added' | 'changed'; id: string; tombstone: RemoteTombstone }
  | { type: 'removed'; id: string };

export type MutationOutcome<T> =
  | { outcome: 'won'; value: T }
  | {
      outcome: 'lost';
      current: RemoteFileRecord | RemoteTombstone | LegacyStorageItem | null;
      reason: 'conflict' | 'tombstone' | 'absent';
    }
  | { outcome: 'rejected'; reason: string };

export interface BlobUploadResult {
  storagePath: string;
  size: number;
  sha256: string;
}

export interface CommitBytesInput {
  id: string;
  name: string;
  mimeType: string;
  revision: string;
  expectedClock: RemoteClock | null;
  bytes: Uint8Array;
  previousBlobPath?: string | null;
}

export interface PublishRecordInput {
  id: string;
  name: string;
  mimeType: string;
  revision: string;
  expectedClock: RemoteClock | null;
  createdAt?: number;
  content:
    | { kind: 'inline'; text: string }
    | { kind: 'blob'; storagePath: string; size: number; sha256: string };
}

export interface RenameRecordInput {
  id: string;
  expectedClock: RemoteClock;
  name: string;
  revision: string;
}

export interface DeleteRecordInput {
  id: string;
  expectedClock: RemoteClock;
  revision: string;
}

/**
 * Firebase-backed remote transport bound to one authenticated UID.
 * Implementations must upload blob bytes before publishing metadata.
 */
export interface VaultTransport {
  readonly uid: string;
  allocateId(): string;
  listLiveChildren(): Promise<LiveChildParse[]>;
  listTombstones(): Promise<Array<{ id: string; tombstone: RemoteTombstone }>>;
  getLiveChild(id: string): Promise<LiveChildParse | null>;
  getTombstone(id: string): Promise<RemoteTombstone | null>;
  subscribeLiveChildren(listener: (event: LiveChildEvent) => void): Unsubscribe;
  subscribeTombstones(listener: (event: TombstoneEvent) => void): Unsubscribe;
  subscribeConnectivity?(listener: (connected: boolean) => void): Unsubscribe;
  uploadBlob(
    id: string,
    revision: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<BlobUploadResult>;
  downloadBlob(storagePath: string): Promise<Uint8Array>;
  deleteBlob(storagePath: string): Promise<{ deleted: boolean }>;
  publishRecord(input: PublishRecordInput): Promise<MutationOutcome<RemoteFileRecord>>;
  commitBytes(input: CommitBytesInput): Promise<MutationOutcome<RemoteFileRecord>>;
  renameRecord(input: RenameRecordInput): Promise<MutationOutcome<RemoteFileRecord>>;
  deleteRecord(input: DeleteRecordInput): Promise<MutationOutcome<RemoteTombstone>>;
  migrateLegacy(id: string): Promise<MutationOutcome<RemoteFileRecord>>;
}
