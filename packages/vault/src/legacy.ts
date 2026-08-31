import type { LegacyStorageItem, RemoteFileRecord } from './model';
import {
  BLOB_CONTENT_KIND,
  INLINE_CONTENT_KIND,
  INLINE_ENCODING,
  REMOTE_SCHEMA_VERSION,
  isUuid,
} from './model';
import { classifyFileContent, sha256Digest, sha256Hex, utf8Bytes } from './content';
import { isSafeLocalName, sanitizePreferredName } from './names';

function bytesToUuid(digest: Uint8Array): string {
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function legacyPreferredName(createdAt: number, id: string): string {
  const candidate = `note-${createdAt}-${id}.txt`;
  if (isSafeLocalName(candidate)) {
    return candidate;
  }
  return sanitizePreferredName(candidate, 'note.txt');
}

async function deriveLegacyRevision(id: string, item: LegacyStorageItem): Promise<string> {
  const digest = await sha256Digest(utf8Bytes(`legacy-v1|${id}|${item.createdAt}|${item.message}`));
  const revision = bytesToUuid(digest);
  if (!isUuid(revision)) {
    throw new Error('Failed to derive a deterministic migration revision.');
  }
  return revision;
}

/** Deterministic revision for a legacy item migration (inline or blob). */
export async function legacyMigrationRevision(
  id: string,
  item: LegacyStorageItem,
): Promise<string> {
  return deriveLegacyRevision(id, item);
}

export async function migrateLegacyStorageItem(
  id: string,
  item: LegacyStorageItem,
  blobStoragePath?: string,
): Promise<RemoteFileRecord> {
  const bytes = utf8Bytes(item.message);
  const placement = classifyFileContent(bytes);
  const sha256 = await sha256Hex(bytes);
  const revision = await deriveLegacyRevision(id, item);

  if (placement.placement === 'inline') {
    return {
      schemaVersion: REMOTE_SCHEMA_VERSION,
      name: legacyPreferredName(item.createdAt, id),
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      size: bytes.byteLength,
      mimeType: 'text/plain',
      sha256,
      revision,
      content: {
        kind: INLINE_CONTENT_KIND,
        text: placement.text,
        encoding: INLINE_ENCODING,
      },
    };
  }

  if (!blobStoragePath) {
    throw new Error('Legacy blob migration requires blobStoragePath after upload.');
  }

  return {
    schemaVersion: REMOTE_SCHEMA_VERSION,
    name: legacyPreferredName(item.createdAt, id),
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    size: bytes.byteLength,
    mimeType: 'text/plain',
    sha256,
    revision,
    content: {
      kind: BLOB_CONTENT_KIND,
      storagePath: blobStoragePath,
    },
  };
}
