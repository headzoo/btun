import { utf8ByteLength } from './content';
import type {
  BlobContent,
  InlineContent,
  LegacyStorageItem,
  RemoteFileRecord,
  RemoteTombstone,
} from './model';
import {
  BLOB_CONTENT_KIND,
  INLINE_CONTENT_KIND,
  INLINE_ENCODING,
  INLINE_TEXT_MAX_CHARS,
  REMOTE_SCHEMA_VERSION,
  isRecord,
  isSha256Hex,
  isUuid,
} from './model';
import { isSafeLocalName } from './names';
import { blobPathMatches, parseBlobObjectPath } from './paths';

export type ParseFailure = { ok: false; error: string };
export type ParseSuccess<T> = { ok: true; value: T };
export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export interface RemoteParseContext {
  uid: string;
  id: string;
}

const REMOTE_KEYS = [
  'schemaVersion',
  'name',
  'createdAt',
  'updatedAt',
  'size',
  'mimeType',
  'sha256',
  'revision',
  'content',
] as const;

function fail(error: string): ParseFailure {
  return { ok: false, error };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) {
    return false;
  }
  return keys.every((key) => actual.includes(key));
}

function isFiniteMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value % 1 === 0;
}

function isMimeType(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 3 && value.length <= 255 && value.includes('/')
  );
}

export function isLegacyStorageItem(value: unknown): value is LegacyStorageItem {
  if (!isRecord(value) || !hasExactKeys(value, ['createdAt', 'message'])) {
    return false;
  }
  return (
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.message === 'string'
  );
}

function parseInlineContent(value: unknown): ParseResult<InlineContent> {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'text', 'encoding'])) {
    return fail('Inline content must have kind, text, and encoding.');
  }
  if (value.kind !== INLINE_CONTENT_KIND) {
    return fail('Unsupported inline content kind.');
  }
  if (value.encoding !== INLINE_ENCODING) {
    return fail('Inline encoding must be utf-8.');
  }
  if (typeof value.text !== 'string') {
    return fail('Inline text must be a string.');
  }
  if (value.text.length > INLINE_TEXT_MAX_CHARS) {
    return fail(`Inline text exceeds ${INLINE_TEXT_MAX_CHARS} characters.`);
  }
  return {
    ok: true,
    value: { kind: INLINE_CONTENT_KIND, text: value.text, encoding: INLINE_ENCODING },
  };
}

function parseBlobContent(value: unknown, ctx: RemoteParseContext): ParseResult<BlobContent> {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'storagePath'])) {
    return fail('Blob content must have kind and storagePath.');
  }
  if (value.kind !== BLOB_CONTENT_KIND) {
    return fail('Unsupported blob content kind.');
  }
  if (typeof value.storagePath !== 'string') {
    return fail('Blob storagePath must be a string.');
  }
  if (!blobPathMatches(value.storagePath, ctx.uid, ctx.id)) {
    return fail('Blob storagePath does not match the authenticated user and record id.');
  }
  return { ok: true, value: { kind: BLOB_CONTENT_KIND, storagePath: value.storagePath } };
}

export function parseRemoteFileRecord(
  value: unknown,
  ctx: RemoteParseContext,
): ParseResult<RemoteFileRecord> {
  if (!isRecord(value) || !hasExactKeys(value, REMOTE_KEYS)) {
    return fail('Remote file record is missing required fields.');
  }
  if (value.schemaVersion !== REMOTE_SCHEMA_VERSION) {
    return fail('Unsupported remote schemaVersion.');
  }
  if (typeof value.name !== 'string' || !isSafeLocalName(value.name)) {
    return fail('Remote preferred name is not a safe filename.');
  }
  if (!isFiniteMillis(value.createdAt) || !isFiniteMillis(value.updatedAt)) {
    return fail('Remote timestamps must be finite non-negative numbers.');
  }
  if (!isNonNegativeInt(value.size)) {
    return fail('Remote size must be a non-negative integer.');
  }
  if (!isMimeType(value.mimeType)) {
    return fail('Remote mimeType is invalid.');
  }
  if (typeof value.sha256 !== 'string' || !isSha256Hex(value.sha256)) {
    return fail('Remote sha256 must be 64 lowercase hex characters.');
  }
  if (typeof value.revision !== 'string' || !isUuid(value.revision)) {
    return fail('Remote revision must be a UUID.');
  }

  if (!isRecord(value.content) || typeof value.content.kind !== 'string') {
    return fail('Remote content is missing a kind.');
  }

  let content: RemoteFileRecord['content'];
  if (value.content.kind === INLINE_CONTENT_KIND) {
    const parsed = parseInlineContent(value.content);
    if (!parsed.ok) {
      return parsed;
    }
    if (utf8ByteLength(parsed.value.text) !== value.size) {
      return fail('Inline size does not match UTF-8 byte length.');
    }
    content = parsed.value;
  } else if (value.content.kind === BLOB_CONTENT_KIND) {
    const parsed = parseBlobContent(value.content, ctx);
    if (!parsed.ok) {
      return parsed;
    }
    const parsedPath = parseBlobObjectPath(parsed.value.storagePath);
    if (!parsedPath) {
      return fail('Blob storagePath is malformed.');
    }
    content = parsed.value;
  } else {
    return fail('Unsupported remote content kind.');
  }

  return {
    ok: true,
    value: {
      schemaVersion: REMOTE_SCHEMA_VERSION,
      name: value.name,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      size: value.size,
      mimeType: value.mimeType,
      sha256: value.sha256,
      revision: value.revision,
      content,
    },
  };
}

export function parseRemoteTombstone(value: unknown): ParseResult<RemoteTombstone> {
  if (!isRecord(value) || !hasExactKeys(value, ['deletedAt', 'revision'])) {
    return fail('Tombstone must have deletedAt and revision.');
  }
  if (!isFiniteMillis(value.deletedAt)) {
    return fail('Tombstone deletedAt must be a finite non-negative number.');
  }
  if (typeof value.revision !== 'string' || !isUuid(value.revision)) {
    return fail('Tombstone revision must be a UUID.');
  }
  return { ok: true, value: { deletedAt: value.deletedAt, revision: value.revision } };
}

export type LiveChildParse =
  | { kind: 'v1'; id: string; record: RemoteFileRecord }
  | { kind: 'legacy'; id: string; item: LegacyStorageItem }
  | { kind: 'invalid'; id: string; reason: string };

export function parseLiveChild(id: string, value: unknown, uid: string): LiveChildParse {
  if (isLegacyStorageItem(value)) {
    return { kind: 'legacy', id, item: value };
  }
  const parsed = parseRemoteFileRecord(value, { uid, id });
  if (parsed.ok) {
    return { kind: 'v1', id, record: parsed.value };
  }
  return { kind: 'invalid', id, reason: parsed.error };
}
