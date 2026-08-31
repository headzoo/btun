import { describe, expect, it } from 'vitest';
import {
  blobObjectPath,
  classifyFileContent,
  clockFromRecord,
  clockFromTombstone,
  compareRemoteClock,
  INLINE_TEXT_MAX_CHARS,
  isLegacyStorageItem,
  legacyPreferredName,
  migrateLegacyStorageItem,
  parseLiveChild,
  parseRemoteFileRecord,
  parseRemoteTombstone,
  sha256Hex,
  utf8Bytes,
  winningRemote,
} from '@yard-1/vault';

const uid = 'userUid1';
const id = '-NabcDEFGHIJKLMNOP12';
const revision = '550e8400-e29b-41d4-a716-446655440000';

describe('classifyFileContent', () => {
  it('inlines exact UTF-8 text without trimming', () => {
    const text = '  hello  ';
    const result = classifyFileContent(utf8Bytes(text));
    expect(result).toEqual({ placement: 'inline', text });
  });

  it('inlines empty files and treats NUL, invalid UTF-8, and long text as blobs', () => {
    expect(classifyFileContent(utf8Bytes(''))).toEqual({ placement: 'inline', text: '' });
    expect(classifyFileContent(new Uint8Array([65, 0, 66])).placement).toBe('blob');
    expect(classifyFileContent(new Uint8Array([0xc3, 0x28])).placement).toBe('blob');
    expect(classifyFileContent(utf8Bytes('a'.repeat(INLINE_TEXT_MAX_CHARS + 1))).placement).toBe(
      'blob',
    );
  });
});

describe('parseRemoteFileRecord', () => {
  it('accepts a valid inline record', () => {
    const parsed = parseRemoteFileRecord(
      {
        schemaVersion: 1,
        name: 'note.txt',
        createdAt: 100,
        updatedAt: 200,
        size: 5,
        mimeType: 'text/plain',
        sha256: 'a'.repeat(64),
        revision,
        content: { kind: 'inline', text: 'hello', encoding: 'utf-8' },
      },
      { uid, id },
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects unsafe names, extra fields, and mismatched blob paths', () => {
    expect(
      parseRemoteFileRecord(
        {
          schemaVersion: 1,
          name: 'foo/bar.txt',
          createdAt: 1,
          updatedAt: 1,
          size: 0,
          mimeType: 'text/plain',
          sha256: 'a'.repeat(64),
          revision,
          content: { kind: 'inline', text: '', encoding: 'utf-8' },
        },
        { uid, id },
      ).ok,
    ).toBe(false);

    expect(
      parseRemoteFileRecord(
        {
          schemaVersion: 1,
          name: 'note.txt',
          createdAt: 1,
          updatedAt: 1,
          size: 3,
          mimeType: 'application/pdf',
          sha256: 'b'.repeat(64),
          revision,
          content: { kind: 'blob', storagePath: blobObjectPath('otherUser', id, revision) },
        },
        { uid, id },
      ).ok,
    ).toBe(false);

    expect(
      parseRemoteFileRecord(
        {
          schemaVersion: 1,
          name: 'note.txt',
          createdAt: 1,
          updatedAt: 1,
          size: 3,
          mimeType: 'application/pdf',
          sha256: 'b'.repeat(64),
          revision,
          content: {
            kind: 'blob',
            storagePath: blobObjectPath(uid, '-NotherIdXXXXXXXXXX', revision),
          },
        },
        { uid, id },
      ).ok,
    ).toBe(false);
  });

  it('accepts a blob path whose revision differs from the metadata revision', () => {
    const contentRevision = '11111111-1111-4111-8111-111111111111';
    const parsed = parseRemoteFileRecord(
      {
        schemaVersion: 1,
        name: 'Report.pdf',
        createdAt: 1,
        updatedAt: 2,
        size: 10,
        mimeType: 'application/pdf',
        sha256: 'c'.repeat(64),
        revision,
        content: { kind: 'blob', storagePath: blobObjectPath(uid, id, contentRevision) },
      },
      { uid, id },
    );
    expect(parsed.ok).toBe(true);
  });
});

describe('legacy records', () => {
  it('recognizes {createdAt, message} items and migrates them deterministically', async () => {
    const item = { createdAt: 1_700_000_000_000, message: '  keep bytes  ' };
    expect(isLegacyStorageItem(item)).toBe(true);
    expect(legacyPreferredName(item.createdAt, id)).toBe(`note-${item.createdAt}-${id}.txt`);

    const first = await migrateLegacyStorageItem(id, item);
    const second = await migrateLegacyStorageItem(id, item);
    expect(first).toEqual(second);
    expect(first.createdAt).toBe(item.createdAt);
    expect(first.updatedAt).toBe(item.createdAt);
    expect(first.content).toEqual({ kind: 'inline', text: item.message, encoding: 'utf-8' });
    expect(first.name).toBe(legacyPreferredName(item.createdAt, id));

    const live = parseLiveChild(id, item, uid);
    expect(live.kind).toBe('legacy');
  });

  it('migrates oversized legacy messages as blob metadata with exact bytes', async () => {
    const message = 'a'.repeat(INLINE_TEXT_MAX_CHARS + 1);
    const item = { createdAt: 1_700_000_000_000, message };
    const bytes = utf8Bytes(message);
    const storagePath = blobObjectPath(uid, id, revision);
    const sha256 = await sha256Hex(bytes);

    const first = await migrateLegacyStorageItem(id, item, storagePath);
    const second = await migrateLegacyStorageItem(id, item, storagePath);
    expect(first).toEqual(second);
    expect(first.size).toBe(bytes.byteLength);
    expect(first.sha256).toBe(sha256);
    expect(first.content).toEqual({ kind: 'blob', storagePath });
    expect(first.createdAt).toBe(item.createdAt);
    expect(first.updatedAt).toBe(item.createdAt);

    await expect(migrateLegacyStorageItem(id, item)).rejects.toThrow(/blobStoragePath/);
  });

  it('migrates legacy messages containing NUL as blob metadata', async () => {
    const message = 'before\u0000after';
    const item = { createdAt: 42, message };
    const storagePath = blobObjectPath(uid, id, revision);
    const migrated = await migrateLegacyStorageItem(id, item, storagePath);

    expect(migrated.content).toEqual({ kind: 'blob', storagePath });
    expect(migrated.size).toBe(utf8Bytes(message).byteLength);
    expect(classifyFileContent(utf8Bytes(message)).placement).toBe('blob');
  });
});

describe('tombstones and clocks', () => {
  it.each([
    {
      a: { updatedAt: 10, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      b: { updatedAt: 20, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      sign: -1,
    },
    {
      a: { updatedAt: 20, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      b: { updatedAt: 20, revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      sign: -1,
    },
    {
      a: { updatedAt: 20, revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      b: { updatedAt: 20, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      sign: 1,
    },
  ])(
    'compareRemoteClock orders ($a.updatedAt,$a.revision) vs ($b.updatedAt,$b.revision)',
    ({ a, b, sign }) => {
      expect(Math.sign(compareRemoteClock(a, b))).toBe(sign);
    },
  );

  it('parses tombstones and picks tombstone over stale record', () => {
    const tombstone = parseRemoteTombstone({ deletedAt: 50, revision });
    expect(tombstone.ok).toBe(true);

    const older = { updatedAt: 10, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const newerTime = { updatedAt: 20, revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const newerRev = { updatedAt: 20, revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    expect(compareRemoteClock(older, newerTime)).toBeLessThan(0);
    expect(compareRemoteClock(newerTime, newerRev)).toBeLessThan(0);

    if (tombstone.ok) {
      const record = {
        schemaVersion: 1 as const,
        name: 'note.txt',
        createdAt: 1,
        updatedAt: 40,
        size: 0,
        mimeType: 'text/plain',
        sha256: 'd'.repeat(64),
        revision,
        content: { kind: 'inline' as const, text: '', encoding: 'utf-8' as const },
      };
      expect(winningRemote(record, tombstone.value)).toBe('tombstone');
      expect(
        compareRemoteClock(clockFromRecord(record), clockFromTombstone(tombstone.value)),
      ).toBeLessThan(0);
    }
  });
});
