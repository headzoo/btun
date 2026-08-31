import { describe, expect, it } from 'vitest';
import {
  isPendingAcknowledged,
  isPendingSuperseded,
  latestPendingForId,
  markPending,
  recoverInFlightOperations,
  replacePendingForId,
  type PendingOperation,
} from '@yard-1/vault';

const revision = '550e8400-e29b-41d4-a716-446655440000';
const newer = '550e8400-e29b-41d4-a716-446655440001';

const updateOp: PendingOperation = {
  kind: 'update',
  opId: 'op1',
  id: 'file1',
  revision,
  queuedAt: 10,
  state: 'in-flight',
  expected: { updatedAt: 5, revision },
  localName: 'note.txt',
};

describe('pending operation journal', () => {
  it.each(['create', 'update', 'rename', 'delete'] as const)(
    'requeues in-flight %s work after a crash',
    (kind) => {
      const base = {
        opId: `op-${kind}`,
        id: 'file1',
        revision,
        queuedAt: 10,
        state: 'in-flight' as const,
      };
      const op: PendingOperation =
        kind === 'create'
          ? { ...base, kind, localName: 'note.txt', preferredName: 'note.txt' }
          : kind === 'update'
            ? { ...base, kind, expected: { updatedAt: 5, revision }, localName: 'note.txt' }
            : kind === 'rename'
              ? { ...base, kind, expected: { updatedAt: 5, revision }, preferredName: 'new.txt' }
              : { ...base, kind, expected: { updatedAt: 5, revision } };
      expect(recoverInFlightOperations([op])[0]?.state).toBe('queued');
    },
  );

  it('replaces an older pending op for the same id', () => {
    const next: PendingOperation = { ...updateOp, opId: 'op2', queuedAt: 20, state: 'queued' };
    const ops = replacePendingForId([updateOp], next);
    expect(ops).toHaveLength(1);
    expect(latestPendingForId(ops, 'file1')?.opId).toBe('op2');
  });

  it('supersedes a pending create when a tombstone clock is present', () => {
    const createOp: PendingOperation = {
      kind: 'create',
      opId: 'op-create',
      id: 'file1',
      revision,
      queuedAt: 10,
      state: 'queued',
      localName: 'note.txt',
      preferredName: 'note.txt',
    };
    expect(isPendingSuperseded(createOp, { updatedAt: 50, revision: newer })).toBe(true);
    expect(isPendingSuperseded(createOp, null, revision)).toBe(false);
    expect(isPendingSuperseded(createOp, { updatedAt: 20, revision }, revision)).toBe(false);
    expect(isPendingSuperseded(createOp, { updatedAt: 20, revision: newer }, newer)).toBe(true);
  });

  it('supersedes stale pending updates when remote is newer', () => {
    expect(isPendingSuperseded(updateOp, { updatedAt: 9, revision: newer })).toBe(true);
    expect(isPendingSuperseded(updateOp, { updatedAt: 5, revision })).toBe(false);
  });

  it('acknowledges a pending create/update when the remote revision matches', () => {
    expect(isPendingAcknowledged(updateOp, revision)).toBe(true);
    expect(isPendingAcknowledged(updateOp, newer)).toBe(false);
  });

  it('records durable failure without dropping the op', () => {
    const failed = markPending([updateOp], 'op1', 'failed', 'hash mismatch');
    expect(failed[0]?.state).toBe('failed');
    expect(failed[0]?.lastError).toBe('hash mismatch');
  });
});
