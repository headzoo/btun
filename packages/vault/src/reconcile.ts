import { compareRemoteClock, winningRemote } from './conflicts';
import type { DirectChildSnapshot } from './contracts';
import type {
  AppliedTombstone,
  PendingOperation,
  VaultIndex,
  VaultIndexEntry,
} from './index-schema';
import { clockFromAppliedRemote, clockFromAppliedTombstone } from './index-schema';
import { isPendingAcknowledged, isPendingSuperseded } from './journal';
import type { RemoteClock, RemoteFileRecord, RemoteTombstone } from './model';
import { clockFromRecord, clockFromTombstone } from './model';
import { splitStemExt, uniquifyLocalName } from './names';
import type { UniquifyOptions } from './names';

export interface ReconcileInput {
  id: string;
  local: { name: string; size: number; mtimeMs: number } | null;
  localSha256: string | null;
  indexEntry: VaultIndexEntry | null;
  pending: PendingOperation | null;
  remoteRecord: RemoteFileRecord | null;
  remoteLegacy: boolean;
  remoteInvalidReason: string | null;
  tombstone: RemoteTombstone | null;
  appliedTombstone: AppliedTombstone | null;
  occupiedNames: string[];
  /** After bootstrap, missing locals are treated as user deletes rather than undownloaded remotes. */
  outwardEnabled: boolean;
  connected: boolean;
  /**
   * True only after listLiveChildren + listTombstones both succeed.
   * When false, absences must not be treated as remote deletions.
   */
  remoteCatalogReady: boolean;
  /**
   * True after this ID was observed locally this generation (scan, successful
   * materialize, or local create/change/rename). Delete-from-absence is only
   * allowed when landed — never-landed remotes rematerialize instead of
   * queue-delete after a failed download.
   */
  landedThisGeneration: boolean;
  uniquifyOptions?: UniquifyOptions;
}

export type ReconcileDecision =
  | { type: 'noop' }
  | { type: 'hash-local' }
  | { type: 'migrate-legacy' }
  | { type: 'ignore-invalid'; reason: string }
  | { type: 'ack-pending'; record: RemoteFileRecord }
  | { type: 'publish-pending' }
  | { type: 'queue-create' }
  | { type: 'queue-update' }
  | { type: 'queue-rename'; preferredName: string }
  | { type: 'queue-delete' }
  | { type: 'materialize-remote'; record: RemoteFileRecord; targetName: string }
  | { type: 'rename-local'; record: RemoteFileRecord; targetName: string }
  | { type: 'apply-tombstone' }
  | { type: 'reject-resurrection' };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `localName` is a per-device uniquify suffix of `preferredName`. */
export function isUniquifiedLocalName(localName: string, preferredName: string): boolean {
  if (localName === preferredName) {
    return false;
  }
  const { stem, ext } = splitStemExt(preferredName);
  const pattern = new RegExp(`^${escapeRegex(stem)}\\.(\\d+)${escapeRegex(ext)}$`);
  return pattern.test(localName);
}

export function chooseLocalName(
  preferredName: string,
  currentLocalName: string | null,
  occupiedNames: readonly string[],
  options?: UniquifyOptions,
): string {
  const occupied = occupiedNames.filter((name) => name !== currentLocalName);
  return uniquifyLocalName(preferredName, occupied, options);
}

function needsHash(input: ReconcileInput): boolean {
  if (!input.local || input.localSha256) {
    return false;
  }
  const identity = input.indexEntry?.identity;
  if (
    identity?.sha256 &&
    identity.size === input.local.size &&
    identity.mtimeMs === input.local.mtimeMs
  ) {
    return false;
  }
  return true;
}

function localHash(input: ReconcileInput): string | null {
  if (input.localSha256) {
    return input.localSha256;
  }
  const identity = input.indexEntry?.identity;
  if (
    identity?.sha256 &&
    input.local &&
    identity.size === input.local.size &&
    identity.mtimeMs === input.local.mtimeMs
  ) {
    return identity.sha256;
  }
  return null;
}

function winningClock(
  record: RemoteFileRecord | null,
  tombstone: RemoteTombstone | null,
): { kind: 'record' | 'tombstone' | 'none'; clock: RemoteClock | null } {
  const winner = winningRemote(record, tombstone);
  if (winner === 'record' && record) {
    return { kind: 'record', clock: clockFromRecord(record) };
  }
  if (winner === 'tombstone' && tombstone) {
    return { kind: 'tombstone', clock: clockFromTombstone(tombstone) };
  }
  return { kind: 'none', clock: null };
}

function appliedClock(input: ReconcileInput): RemoteClock | null {
  if (input.indexEntry?.appliedRemote) {
    return clockFromAppliedRemote(input.indexEntry.appliedRemote);
  }
  return null;
}

/**
 * Pure last-(updatedAt, revision) reconcile decision. Does not inspect filenames
 * as identity and does not compare client wall clocks.
 */
export function decideReconcile(input: ReconcileInput): ReconcileDecision {
  if (input.remoteLegacy) {
    return { type: 'migrate-legacy' };
  }

  if (input.remoteInvalidReason && !input.tombstone) {
    return { type: 'ignore-invalid', reason: input.remoteInvalidReason };
  }

  const live = winningClock(input.remoteRecord, input.tombstone);

  if (input.appliedTombstone) {
    const remembered = clockFromAppliedTombstone(input.appliedTombstone);
    if (live.kind === 'record' && live.clock && compareRemoteClock(live.clock, remembered) < 0) {
      return { type: 'reject-resurrection' };
    }
    if (live.kind === 'none' && !input.local && !input.indexEntry) {
      return { type: 'noop' };
    }
  }

  if (live.kind === 'tombstone') {
    return decideTombstone(input, live.clock);
  }

  if (input.remoteInvalidReason) {
    return { type: 'ignore-invalid', reason: input.remoteInvalidReason };
  }

  if (
    input.pending &&
    input.remoteRecord &&
    isPendingAcknowledged(input.pending, input.remoteRecord.revision)
  ) {
    return { type: 'ack-pending', record: input.remoteRecord };
  }

  if (
    input.pending &&
    isPendingSuperseded(input.pending, live.clock, input.remoteRecord?.revision)
  ) {
    if (live.kind === 'record' && input.remoteRecord) {
      return materializeOrRename(input, input.remoteRecord);
    }
    if (!input.remoteCatalogReady && live.kind === 'none') {
      return { type: 'noop' };
    }
    return { type: 'apply-tombstone' };
  }

  if (input.pending) {
    if (!input.connected || !input.remoteCatalogReady) {
      return { type: 'noop' };
    }
    return { type: 'publish-pending' };
  }

  if (live.kind === 'record' && input.remoteRecord) {
    return decideRemoteRecord(input, input.remoteRecord);
  }

  return decideLocalOnly(input);
}

function decideTombstone(input: ReconcileInput, tombClock: RemoteClock | null): ReconcileDecision {
  if (input.pending) {
    // Never publish-pending a create (expectedClock: null) onto a deleted ID.
    if (
      input.pending.kind === 'create' ||
      (tombClock !== null && isPendingSuperseded(input.pending, tombClock))
    ) {
      return { type: 'apply-tombstone' };
    }
    if (!input.connected || !input.remoteCatalogReady) {
      return { type: 'noop' };
    }
    return { type: 'publish-pending' };
  }
  if (input.local || input.indexEntry) {
    return { type: 'apply-tombstone' };
  }
  if (input.appliedTombstone) {
    return { type: 'noop' };
  }
  return { type: 'apply-tombstone' };
}

function decideRemoteRecord(input: ReconcileInput, record: RemoteFileRecord): ReconcileDecision {
  const applied = input.indexEntry?.appliedRemote;
  const appliedClk = appliedClock(input);
  const remoteClk = clockFromRecord(record);

  if (!input.local) {
    // Only treat absence as a user delete after the file landed this generation.
    // Never-landed indexed remotes (failed/pending materialize) must rematerialize,
    // not queue-delete the live cloud record once outwardEnabled flips true.
    if (input.outwardEnabled && input.indexEntry && input.landedThisGeneration) {
      if (!appliedClk || compareRemoteClock(remoteClk, appliedClk) <= 0) {
        return { type: 'queue-delete' };
      }
    }
    return materializeOrRename(input, record);
  }

  if (needsHash(input) && !localHash(input)) {
    return { type: 'hash-local' };
  }

  const hash = localHash(input);
  const remoteNewer = !appliedClk || compareRemoteClock(remoteClk, appliedClk) > 0;
  const remoteSame = appliedClk ? compareRemoteClock(remoteClk, appliedClk) === 0 : false;

  if (remoteNewer && hash !== record.sha256) {
    return materializeOrRename(input, record);
  }

  if (remoteNewer && hash === record.sha256) {
    return materializeOrRename(input, record);
  }

  if (hash && hash !== record.sha256 && (remoteSame || (applied && hash !== applied.sha256))) {
    return { type: 'queue-update' };
  }

  if (hash && hash === record.sha256) {
    return materializeOrRename(input, record);
  }

  if (
    !hash &&
    applied &&
    applied.sha256 === record.sha256 &&
    applied.revision === record.revision
  ) {
    return materializeOrRename(input, record);
  }

  return { type: 'noop' };
}

function materializeOrRename(input: ReconcileInput, record: RemoteFileRecord): ReconcileDecision {
  const currentName = input.local?.name ?? input.indexEntry?.localName ?? null;
  const targetName = chooseLocalName(
    record.name,
    currentName,
    input.occupiedNames,
    input.uniquifyOptions,
  );
  const hash = localHash(input);

  if (input.local && hash === record.sha256) {
    if (input.local.name === targetName) {
      const applied = input.indexEntry?.appliedRemote;
      if (
        applied &&
        applied.revision === record.revision &&
        applied.updatedAt === record.updatedAt &&
        applied.sha256 === record.sha256 &&
        applied.preferredName === record.name &&
        input.indexEntry?.localName === input.local.name
      ) {
        return { type: 'noop' };
      }
      return { type: 'rename-local', record, targetName };
    }
    return { type: 'rename-local', record, targetName };
  }

  if (
    input.local &&
    hash === record.sha256 &&
    input.local.name === targetName &&
    input.indexEntry?.appliedRemote?.revision === record.revision
  ) {
    return { type: 'noop' };
  }

  return { type: 'materialize-remote', record, targetName };
}

function decideLocalOnly(input: ReconcileInput): ReconcileDecision {
  if (!input.remoteCatalogReady) {
    // Unlisted catalog must not look like "remote deleted" or trigger publishes.
    return { type: 'noop' };
  }

  if (!input.local) {
    if (!input.outwardEnabled) {
      return { type: 'noop' };
    }
    // Absence is only a user delete after the ID landed this generation.
    if (!input.landedThisGeneration) {
      return { type: 'noop' };
    }
    if (input.indexEntry?.appliedRemote) {
      return { type: 'queue-delete' };
    }
    if (input.indexEntry || input.appliedTombstone) {
      return { type: 'apply-tombstone' };
    }
    return { type: 'noop' };
  }

  if (!input.indexEntry) {
    return { type: 'noop' };
  }

  if (needsHash(input) && !localHash(input)) {
    return { type: 'hash-local' };
  }

  const hash = localHash(input);
  const applied = input.indexEntry.appliedRemote;
  if (applied && hash && hash !== applied.sha256) {
    return { type: 'queue-update' };
  }

  if (
    applied &&
    input.local.name !== applied.preferredName &&
    !isUniquifiedLocalName(input.local.name, applied.preferredName)
  ) {
    return { type: 'queue-rename', preferredName: input.local.name };
  }

  if (!applied) {
    return { type: 'queue-create' };
  }

  return { type: 'noop' };
}

function identityKey(identity: { dev?: string; ino?: string } | undefined): string | null {
  if (!identity?.dev || !identity.ino) {
    return null;
  }
  return `${identity.dev}:${identity.ino}`;
}

/**
 * After a restart, rebind index localNames when platform identity still matches
 * a direct child that was renamed while the app was stopped.
 */
export function rebindIndexNamesByIdentity(
  index: VaultIndex,
  children: readonly DirectChildSnapshot[],
): VaultIndex {
  const byIdentity = new Map<string, DirectChildSnapshot>();
  for (const child of children) {
    const key = identityKey(child.identity);
    if (key) {
      byIdentity.set(key, child);
    }
  }

  let changed = false;
  const entries: VaultIndex['entries'] = { ...index.entries };
  for (const [id, entry] of Object.entries(entries)) {
    const key = identityKey(entry.identity);
    if (!key) {
      continue;
    }
    const child = byIdentity.get(key);
    if (child && child.name !== entry.localName) {
      entries[id] = { ...entry, localName: child.name };
      changed = true;
    }
  }
  return changed ? { ...index, entries } : index;
}

export function unmappedLocalNames(
  children: readonly DirectChildSnapshot[],
  index: VaultIndex,
): string[] {
  const mapped = new Set(Object.values(index.entries).map((entry) => entry.localName));
  return children.filter((child) => !mapped.has(child.name)).map((child) => child.name);
}

export function collectKnownIds(
  index: VaultIndex,
  remoteIds: Iterable<string>,
  tombstoneIds: Iterable<string>,
): string[] {
  const ids = new Set<string>([
    ...Object.keys(index.entries),
    ...Object.keys(index.appliedTombstones),
    ...index.pendingOperations.map((op) => op.id),
  ]);
  for (const id of remoteIds) {
    ids.add(id);
  }
  for (const id of tombstoneIds) {
    ids.add(id);
  }
  return [...ids];
}
