import type { PendingOpState, PendingOperation } from './index-schema';
import { compareRemoteClock } from './conflicts';
import type { RemoteClock } from './model';
import { newVaultRevision } from './model';

export function newPendingOpId(): string {
  return newVaultRevision();
}

/** Crash recovery: in-flight work is retried after restart. */
export function recoverInFlightOperations(ops: readonly PendingOperation[]): PendingOperation[] {
  return ops.map((op) =>
    op.state === 'in-flight' ? { ...op, state: 'queued' as const } : { ...op },
  );
}

export function latestPendingForId(
  ops: readonly PendingOperation[],
  id: string,
): PendingOperation | null {
  let found: PendingOperation | null = null;
  for (const op of ops) {
    if (op.id !== id) {
      continue;
    }
    if (!found || op.queuedAt >= found.queuedAt) {
      found = op;
    }
  }
  return found;
}

/** A newer queued op for the same ID replaces any previous journal entry. */
export function replacePendingForId(
  ops: readonly PendingOperation[],
  next: PendingOperation,
): PendingOperation[] {
  return [...ops.filter((op) => op.id !== next.id), next];
}

export function removePendingForId(
  ops: readonly PendingOperation[],
  id: string,
): PendingOperation[] {
  return ops.filter((op) => op.id !== id);
}

export function removePendingOp(
  ops: readonly PendingOperation[],
  opId: string,
): PendingOperation[] {
  return ops.filter((op) => op.opId !== opId);
}

export function markPending(
  ops: readonly PendingOperation[],
  opId: string,
  state: PendingOpState,
  lastError?: string,
): PendingOperation[] {
  return ops.map((op) => {
    if (op.opId !== opId) {
      return op;
    }
    const next: PendingOperation = { ...op, state };
    if (lastError !== undefined) {
      next.lastError = lastError;
    } else {
      delete next.lastError;
    }
    return next;
  });
}

/**
 * Proven newer remote state supersedes a queued local mutation.
 * Create ops have no expected clock: they complete when the remote revision
 * matches, and are superseded by a winning tombstone or a different live revision.
 */
export function isPendingSuperseded(
  pending: PendingOperation,
  remoteClock: RemoteClock | null,
  remoteRevision?: string,
): boolean {
  if (pending.kind === 'create') {
    if (remoteRevision !== undefined) {
      return remoteRevision !== pending.revision;
    }
    return remoteClock !== null;
  }
  if (!remoteClock) {
    return false;
  }
  return compareRemoteClock(remoteClock, pending.expected) > 0;
}

export function isPendingAcknowledged(
  pending: PendingOperation,
  remoteRevision: string | undefined,
): boolean {
  return remoteRevision !== undefined && remoteRevision === pending.revision;
}
