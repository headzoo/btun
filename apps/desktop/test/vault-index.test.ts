import { describe, expect, it } from 'vitest';
import {
  bindVaultIndexToOwner,
  createEmptyVaultIndex,
  parseVaultIndex,
  parseVaultIndexText,
  serializeVaultIndex,
} from '@yard-1/vault';

const ownerUid = 'ownerUid1';
const revision = '550e8400-e29b-41d4-a716-446655440000';

describe('vault index schema', () => {
  it('creates and round-trips a v1 index', () => {
    const index = createEmptyVaultIndex(ownerUid);
    index.entries['-NabcDEFGHIJKLMNOP12'] = {
      id: '-NabcDEFGHIJKLMNOP12',
      localName: 'Report.2.pdf',
      appliedRemote: {
        revision,
        updatedAt: 10,
        sha256: 'a'.repeat(64),
        size: 12,
        preferredName: 'Report.pdf',
      },
      identity: { dev: '1', ino: '2' },
    };
    index.pendingOperations.push({
      kind: 'create',
      opId: 'op1',
      id: '-NabcDEFGHIJKLMNOP12',
      revision,
      queuedAt: 11,
      state: 'queued',
      localName: 'Report.2.pdf',
      preferredName: 'Report.pdf',
    });

    const text = serializeVaultIndex(index);
    const loaded = parseVaultIndexText(text);
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.index).toEqual(index);
    }
  });

  it('reports missing, corrupt, unsupported, and owner-mismatch results', () => {
    expect(parseVaultIndexText('').status).toBe('missing');
    expect(parseVaultIndexText('{not json').status).toBe('corrupt');
    expect(parseVaultIndex({ schemaVersion: 2, ownerUid }).status).toBe('unsupported-version');
    expect(
      parseVaultIndex({ schemaVersion: 1, ownerUid: 'bad.uid', entries: {}, pendingOperations: [] })
        .status,
    ).toBe('corrupt');

    const index = createEmptyVaultIndex(ownerUid);
    const mismatch = bindVaultIndexToOwner(index, 'otherUid');
    expect(mismatch.status).toBe('owner-mismatch');
    if (mismatch.status === 'owner-mismatch') {
      expect(mismatch.ownerUid).toBe(ownerUid);
      expect(mismatch.expectedUid).toBe('otherUid');
    }
  });

  it('rejects unsafe local names and duplicate pending op ids', () => {
    const parsed = parseVaultIndex({
      schemaVersion: 1,
      ownerUid,
      entries: {
        '-NabcDEFGHIJKLMNOP12': {
          id: '-NabcDEFGHIJKLMNOP12',
          localName: '../escape.txt',
        },
      },
      pendingOperations: [],
    });
    expect(parsed.status).toBe('corrupt');
  });

  it('round-trips applied tombstones and pending journal entries', () => {
    const index = createEmptyVaultIndex(ownerUid);
    index.appliedTombstones['-Ndeleted00000000001'] = {
      revision,
      deletedAt: 99,
    };
    index.pendingOperations = [
      {
        kind: 'delete',
        opId: 'op-del',
        id: '-Ndeleted00000000001',
        revision,
        queuedAt: 100,
        state: 'queued',
        expected: { updatedAt: 50, revision },
      },
    ];
    const loaded = parseVaultIndexText(serializeVaultIndex(index));
    expect(loaded.status).toBe('ok');
    if (loaded.status === 'ok') {
      expect(loaded.index.appliedTombstones['-Ndeleted00000000001']).toEqual({
        revision,
        deletedAt: 99,
      });
      expect(loaded.index.pendingOperations).toHaveLength(1);
    }
  });

  it('binds an index to the matching owner and rejects mismatches', () => {
    const index = createEmptyVaultIndex(ownerUid);
    const ok = bindVaultIndexToOwner(index, ownerUid);
    expect(ok.status).toBe('ok');
    const bad = bindVaultIndexToOwner(index, 'otherUid');
    expect(bad.status).toBe('owner-mismatch');
  });

  it('rejects duplicate pending op ids', () => {
    const parsed = parseVaultIndex({
      schemaVersion: 1,
      ownerUid,
      entries: {},
      pendingOperations: [
        {
          kind: 'create',
          opId: 'dup',
          id: '-NabcDEFGHIJKLMNOP12',
          revision,
          queuedAt: 1,
          state: 'queued',
          localName: 'a.txt',
          preferredName: 'a.txt',
        },
        {
          kind: 'update',
          opId: 'dup',
          id: '-NabcDEFGHIJKLMNOP12',
          revision,
          queuedAt: 2,
          state: 'queued',
          expected: { updatedAt: 1, revision },
          localName: 'a.txt',
        },
      ],
    });
    expect(parsed.status).toBe('corrupt');
  });
});
