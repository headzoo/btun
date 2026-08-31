import type { RemoteClock } from './model';
import { isRecord, isSha256Hex, isUuid, VAULT_INDEX_SCHEMA_VERSION } from './model';
import { isSafeLocalName as isSafeFileName } from './names';
import { isSafePathSegment } from './paths';

export type PendingOpState = 'queued' | 'in-flight' | 'failed';

interface PendingOperationBase {
  opId: string;
  id: string;
  revision: string;
  queuedAt: number;
  state: PendingOpState;
  lastError?: string;
}

export type PendingOperation =
  | (PendingOperationBase & {
      kind: 'create';
      localName: string;
      preferredName: string;
    })
  | (PendingOperationBase & {
      kind: 'update';
      expected: RemoteClock;
      localName: string;
    })
  | (PendingOperationBase & {
      kind: 'rename';
      expected: RemoteClock;
      preferredName: string;
    })
  | (PendingOperationBase & {
      kind: 'delete';
      expected: RemoteClock;
    });

export interface AppliedRemoteState {
  revision: string;
  updatedAt: number;
  sha256: string;
  size: number;
  preferredName: string;
  /** Last known blob object path; may differ from metadata revision after rename. */
  blobPath?: string;
}

/** Remembered winning tombstone used to reject stale resurrection after local cleanup. */
export interface AppliedTombstone {
  revision: string;
  deletedAt: number;
}

export interface PlatformFileIdentity {
  dev?: string;
  ino?: string;
  size?: number;
  mtimeMs?: number;
  sha256?: string;
}

export interface VaultIndexEntry {
  id: string;
  localName: string;
  appliedRemote?: AppliedRemoteState;
  identity?: PlatformFileIdentity;
}

export interface VaultIndex {
  schemaVersion: typeof VAULT_INDEX_SCHEMA_VERSION;
  ownerUid: string;
  entries: Record<string, VaultIndexEntry>;
  pendingOperations: PendingOperation[];
  appliedTombstones: Record<string, AppliedTombstone>;
}

export type VaultIndexLoadResult =
  | { status: 'ok'; index: VaultIndex }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }
  | { status: 'unsupported-version'; version: number }
  | { status: 'owner-mismatch'; ownerUid: string; expectedUid: string };

const PENDING_STATES: readonly PendingOpState[] = ['queued', 'in-flight', 'failed'];

function isFiniteMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseRemoteClock(value: unknown): RemoteClock | null {
  if (
    !isRecord(value) ||
    typeof value.updatedAt !== 'number' ||
    typeof value.revision !== 'string'
  ) {
    return null;
  }
  if (!isFiniteMillis(value.updatedAt) || !isUuid(value.revision)) {
    return null;
  }
  return { updatedAt: value.updatedAt, revision: value.revision };
}

function parseIdentity(value: unknown): PlatformFileIdentity | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const identity: PlatformFileIdentity = {};
  if (typeof value.dev === 'string' && value.dev.length > 0) {
    identity.dev = value.dev;
  }
  if (typeof value.ino === 'string' && value.ino.length > 0) {
    identity.ino = value.ino;
  }
  if (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0) {
    identity.size = value.size;
  }
  if (typeof value.mtimeMs === 'number' && Number.isFinite(value.mtimeMs)) {
    identity.mtimeMs = value.mtimeMs;
  }
  if (typeof value.sha256 === 'string' && isSha256Hex(value.sha256)) {
    identity.sha256 = value.sha256;
  }
  return identity;
}

function parseAppliedRemote(value: unknown): AppliedRemoteState | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.revision !== 'string' || !isUuid(value.revision)) {
    return undefined;
  }
  if (!isFiniteMillis(value.updatedAt)) {
    return undefined;
  }
  if (typeof value.sha256 !== 'string' || !isSha256Hex(value.sha256)) {
    return undefined;
  }
  if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) {
    return undefined;
  }
  if (typeof value.preferredName !== 'string' || !isSafeFileName(value.preferredName)) {
    return undefined;
  }
  const applied: AppliedRemoteState = {
    revision: value.revision,
    updatedAt: value.updatedAt,
    sha256: value.sha256,
    size: value.size,
    preferredName: value.preferredName,
  };
  if (value.blobPath !== undefined) {
    if (typeof value.blobPath !== 'string' || value.blobPath.length === 0) {
      return undefined;
    }
    applied.blobPath = value.blobPath;
  }
  return applied;
}

function parseAppliedTombstone(value: unknown): AppliedTombstone | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.revision !== 'string' || !isUuid(value.revision)) {
    return null;
  }
  if (!isFiniteMillis(value.deletedAt)) {
    return null;
  }
  return { revision: value.revision, deletedAt: value.deletedAt };
}

function parsePendingBase(value: Record<string, unknown>): PendingOperationBase | null {
  if (typeof value.opId !== 'string' || value.opId.length === 0) {
    return null;
  }
  if (typeof value.id !== 'string' || !isSafePathSegment(value.id)) {
    return null;
  }
  if (typeof value.revision !== 'string' || !isUuid(value.revision)) {
    return null;
  }
  if (!isFiniteMillis(value.queuedAt)) {
    return null;
  }
  if (typeof value.state !== 'string' || !PENDING_STATES.includes(value.state as PendingOpState)) {
    return null;
  }
  const base: PendingOperationBase = {
    opId: value.opId,
    id: value.id,
    revision: value.revision,
    queuedAt: value.queuedAt,
    state: value.state as PendingOpState,
  };
  if (value.lastError !== undefined) {
    if (typeof value.lastError !== 'string') {
      return null;
    }
    base.lastError = value.lastError;
  }
  return base;
}

function parsePendingOperation(value: unknown): PendingOperation | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  const base = parsePendingBase(value);
  if (!base) {
    return null;
  }
  if (value.kind === 'create') {
    if (typeof value.localName !== 'string' || !isSafeFileName(value.localName)) {
      return null;
    }
    if (typeof value.preferredName !== 'string' || !isSafeFileName(value.preferredName)) {
      return null;
    }
    return {
      ...base,
      kind: 'create',
      localName: value.localName,
      preferredName: value.preferredName,
    };
  }
  if (value.kind === 'update') {
    const expected = parseRemoteClock(value.expected);
    if (!expected || typeof value.localName !== 'string' || !isSafeFileName(value.localName)) {
      return null;
    }
    return { ...base, kind: 'update', expected, localName: value.localName };
  }
  if (value.kind === 'rename') {
    const expected = parseRemoteClock(value.expected);
    if (
      !expected ||
      typeof value.preferredName !== 'string' ||
      !isSafeFileName(value.preferredName)
    ) {
      return null;
    }
    return { ...base, kind: 'rename', expected, preferredName: value.preferredName };
  }
  if (value.kind === 'delete') {
    const expected = parseRemoteClock(value.expected);
    if (!expected) {
      return null;
    }
    return { ...base, kind: 'delete', expected };
  }
  return null;
}

function parseEntry(id: string, value: unknown): VaultIndexEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.id !== id || typeof value.id !== 'string' || !isSafePathSegment(value.id)) {
    return null;
  }
  if (typeof value.localName !== 'string' || !isSafeFileName(value.localName)) {
    return null;
  }
  const entry: VaultIndexEntry = { id, localName: value.localName };
  const applied = parseAppliedRemote(value.appliedRemote);
  if (value.appliedRemote !== undefined && !applied) {
    return null;
  }
  if (applied) {
    entry.appliedRemote = applied;
  }
  if (value.identity !== undefined) {
    const identity = parseIdentity(value.identity);
    if (!identity) {
      return null;
    }
    entry.identity = identity;
  }
  return entry;
}

export function createEmptyVaultIndex(ownerUid: string): VaultIndex {
  if (!isSafePathSegment(ownerUid)) {
    throw new Error('Invalid owner uid.');
  }
  return {
    schemaVersion: VAULT_INDEX_SCHEMA_VERSION,
    ownerUid,
    entries: {},
    pendingOperations: [],
    appliedTombstones: {},
  };
}

export function parseVaultIndex(value: unknown): VaultIndexLoadResult {
  if (!isRecord(value)) {
    return { status: 'corrupt', error: 'Index root must be an object.' };
  }
  if (typeof value.schemaVersion !== 'number') {
    return { status: 'corrupt', error: 'Index is missing schemaVersion.' };
  }
  if (value.schemaVersion !== VAULT_INDEX_SCHEMA_VERSION) {
    if (value.schemaVersion > VAULT_INDEX_SCHEMA_VERSION) {
      return { status: 'unsupported-version', version: value.schemaVersion };
    }
    return { status: 'corrupt', error: `Unknown index schemaVersion ${value.schemaVersion}.` };
  }
  if (typeof value.ownerUid !== 'string' || !isSafePathSegment(value.ownerUid)) {
    return { status: 'corrupt', error: 'Index ownerUid is invalid.' };
  }
  if (!isRecord(value.entries)) {
    return { status: 'corrupt', error: 'Index entries must be an object.' };
  }
  if (!Array.isArray(value.pendingOperations)) {
    return { status: 'corrupt', error: 'Index pendingOperations must be an array.' };
  }

  const entries: Record<string, VaultIndexEntry> = {};
  for (const [id, raw] of Object.entries(value.entries)) {
    const entry = parseEntry(id, raw);
    if (!entry) {
      return { status: 'corrupt', error: `Index entry ${id} is invalid.` };
    }
    entries[id] = entry;
  }

  const pendingOperations: PendingOperation[] = [];
  const seenOpIds = new Set<string>();
  for (const raw of value.pendingOperations) {
    const op = parsePendingOperation(raw);
    if (!op) {
      return { status: 'corrupt', error: 'Index pending operation is invalid.' };
    }
    if (seenOpIds.has(op.opId)) {
      return { status: 'corrupt', error: 'Index pending operation ids must be unique.' };
    }
    seenOpIds.add(op.opId);
    pendingOperations.push(op);
  }

  const appliedTombstones: Record<string, AppliedTombstone> = {};
  if (value.appliedTombstones !== undefined) {
    if (!isRecord(value.appliedTombstones)) {
      return { status: 'corrupt', error: 'Index appliedTombstones must be an object.' };
    }
    for (const [id, raw] of Object.entries(value.appliedTombstones)) {
      if (!isSafePathSegment(id)) {
        return { status: 'corrupt', error: `Index tombstone id ${id} is invalid.` };
      }
      const tombstone = parseAppliedTombstone(raw);
      if (!tombstone) {
        return { status: 'corrupt', error: `Index applied tombstone ${id} is invalid.` };
      }
      appliedTombstones[id] = tombstone;
    }
  }

  return {
    status: 'ok',
    index: {
      schemaVersion: VAULT_INDEX_SCHEMA_VERSION,
      ownerUid: value.ownerUid,
      entries,
      pendingOperations,
      appliedTombstones,
    },
  };
}

export function parseVaultIndexText(text: string): VaultIndexLoadResult {
  if (text.trim() === '') {
    return { status: 'missing' };
  }
  try {
    return parseVaultIndex(JSON.parse(text) as unknown);
  } catch {
    return { status: 'corrupt', error: 'Index is not valid JSON.' };
  }
}

export function bindVaultIndexToOwner(index: VaultIndex, uid: string): VaultIndexLoadResult {
  if (index.ownerUid !== uid) {
    return { status: 'owner-mismatch', ownerUid: index.ownerUid, expectedUid: uid };
  }
  return { status: 'ok', index };
}

export function serializeVaultIndex(index: VaultIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function clockFromAppliedRemote(applied: AppliedRemoteState): RemoteClock {
  return { updatedAt: applied.updatedAt, revision: applied.revision };
}

export function clockFromAppliedTombstone(tombstone: AppliedTombstone): RemoteClock {
  return { updatedAt: tombstone.deletedAt, revision: tombstone.revision };
}
