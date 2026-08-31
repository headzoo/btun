/** v1 remote metadata schema version stored in RTDB. */
export const REMOTE_SCHEMA_VERSION = 1;

/** Maximum JavaScript string length eligible for inline RTDB storage. */
export const INLINE_TEXT_MAX_CHARS = 10000;

/** Upper bound on UTF-8 bytes for an inline payload (4 bytes per JS char). */
export const INLINE_TEXT_MAX_BYTES = INLINE_TEXT_MAX_CHARS * 4;

/** Local hidden index filename; never listed or synced as a vault file. */
export const VAULT_INDEX_FILENAME = '.buddy-tunnel.json';

/** Backup name used when recovering a corrupt index. */
export const VAULT_INDEX_BACKUP_FILENAME = '.buddy-tunnel.json.bak';

export const VAULT_INDEX_SCHEMA_VERSION = 1;

export const MAX_FILENAME_LENGTH = 255;

export const INLINE_CONTENT_KIND = 'inline' as const;
export const BLOB_CONTENT_KIND = 'blob' as const;
export const INLINE_ENCODING = 'utf-8' as const;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type InlineContent = {
  kind: typeof INLINE_CONTENT_KIND;
  text: string;
  encoding: typeof INLINE_ENCODING;
};

export type BlobContent = {
  kind: typeof BLOB_CONTENT_KIND;
  storagePath: string;
};

export type RemoteFileContent = InlineContent | BlobContent;

/**
 * v1 live RTDB record stored at storage/{uid}/{id}.
 * `name` is the preferred remote name and may duplicate across IDs.
 */
export interface RemoteFileRecord {
  schemaVersion: typeof REMOTE_SCHEMA_VERSION;
  name: string;
  createdAt: number;
  updatedAt: number;
  size: number;
  mimeType: string;
  sha256: string;
  revision: string;
  content: RemoteFileContent;
}

/** Sibling deletion marker at storageTombstones/{uid}/{id}. */
export interface RemoteTombstone {
  deletedAt: number;
  revision: string;
}

/** Last-write-wins clock. Tombstones use deletedAt as updatedAt. */
export interface RemoteClock {
  updatedAt: number;
  revision: string;
}

/** Materialized local file as shown in the UI. */
export interface FileEntry {
  id: string;
  localName: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
  sha256?: string;
  preferredName?: string;
  revision?: string;
  updatedAt?: number;
  status: 'ready' | 'pending' | 'error' | 'missing';
  errorMessage?: string;
}

export interface LegacyStorageItem {
  createdAt: number;
  message: string;
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clockFromRecord(record: RemoteFileRecord): RemoteClock {
  return { updatedAt: record.updatedAt, revision: record.revision };
}

export function clockFromTombstone(tombstone: RemoteTombstone): RemoteClock {
  return { updatedAt: tombstone.deletedAt, revision: tombstone.revision };
}

export function newVaultRevision(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required to allocate vault revisions.');
  }
  return globalThis.crypto.randomUUID();
}
