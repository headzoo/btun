import { isUuid } from './model';

export const RTDB_LIVE_ROOT = 'storage';
export const RTDB_TOMBSTONE_ROOT = 'storageTombstones';
export const BLOB_OBJECT_ROOT = 'vault';

const ILLEGAL_PATH_CHARS = /[.#$[\]/]/;

export function isSafePathSegment(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !ILLEGAL_PATH_CHARS.test(value);
}

export function assertPathSegment(value: string, label: string): string {
  if (!isSafePathSegment(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function rtdbLiveRoot(uid: string): string {
  return `${RTDB_LIVE_ROOT}/${assertPathSegment(uid, 'uid')}`;
}

export function rtdbLivePath(uid: string, id: string): string {
  return `${rtdbLiveRoot(uid)}/${assertPathSegment(id, 'id')}`;
}

export function rtdbTombstoneRoot(uid: string): string {
  return `${RTDB_TOMBSTONE_ROOT}/${assertPathSegment(uid, 'uid')}`;
}

export function rtdbTombstonePath(uid: string, id: string): string {
  return `${rtdbTombstoneRoot(uid)}/${assertPathSegment(id, 'id')}`;
}

export function blobObjectPath(uid: string, id: string, revision: string): string {
  if (!isUuid(revision)) {
    throw new Error('Invalid blob revision.');
  }
  return `${BLOB_OBJECT_ROOT}/${assertPathSegment(uid, 'uid')}/${assertPathSegment(id, 'id')}/${revision}`;
}

export interface ParsedBlobPath {
  uid: string;
  id: string;
  revision: string;
}

export function parseBlobObjectPath(storagePath: string): ParsedBlobPath | null {
  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    return null;
  }
  const parts = storagePath.split('/');
  if (parts.length !== 4 || parts[0] !== BLOB_OBJECT_ROOT) {
    return null;
  }
  const uid = parts[1];
  const id = parts[2];
  const revision = parts[3];
  if (!isSafePathSegment(uid) || !isSafePathSegment(id) || !isUuid(revision)) {
    return null;
  }
  return { uid, id, revision };
}

export function blobPathMatches(
  storagePath: string,
  uid: string,
  id: string,
  revision?: string,
): boolean {
  const parsed = parseBlobObjectPath(storagePath);
  if (!parsed) {
    return false;
  }
  if (parsed.uid !== uid || parsed.id !== id) {
    return false;
  }
  if (revision !== undefined && parsed.revision !== revision) {
    return false;
  }
  return true;
}
