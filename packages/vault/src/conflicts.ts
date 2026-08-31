import type { RemoteClock, RemoteFileRecord, RemoteTombstone } from './model';
import { clockFromRecord, clockFromTombstone } from './model';

/** Compare (updatedAt, revision). Negative if a is older. */
export function compareRemoteClock(a: RemoteClock, b: RemoteClock): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? -1 : 1;
  }
  if (a.revision === b.revision) {
    return 0;
  }
  return a.revision < b.revision ? -1 : 1;
}

export function clocksEqual(a: RemoteClock, b: RemoteClock): boolean {
  return compareRemoteClock(a, b) === 0;
}

export type WinningRemote = 'record' | 'tombstone' | 'none';

export function winningRemote(
  record: RemoteFileRecord | null,
  tombstone: RemoteTombstone | null,
): WinningRemote {
  if (!record && !tombstone) {
    return 'none';
  }
  if (record && !tombstone) {
    return 'record';
  }
  if (!record && tombstone) {
    return 'tombstone';
  }
  if (record && tombstone) {
    return compareRemoteClock(clockFromRecord(record), clockFromTombstone(tombstone)) >= 0
      ? 'record'
      : 'tombstone';
  }
  return 'none';
}

export type ReconcileAction =
  | { type: 'noop' }
  | { type: 'migrate-legacy'; id: string }
  | { type: 'adopt-local'; localName: string }
  | { type: 'materialize-remote'; id: string }
  | { type: 'publish-local'; id: string }
  | { type: 'publish-rename'; id: string }
  | { type: 'rename-local'; id: string; to: string }
  | { type: 'apply-remote-rename'; id: string; to: string }
  | { type: 'apply-tombstone'; id: string }
  | { type: 'publish-delete'; id: string }
  | { type: 'ack-pending'; id: string }
  | { type: 'ignore-invalid'; id: string; reason: string };
