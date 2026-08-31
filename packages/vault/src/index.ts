export {
  BLOB_CONTENT_KIND,
  INLINE_CONTENT_KIND,
  INLINE_ENCODING,
  INLINE_TEXT_MAX_BYTES,
  INLINE_TEXT_MAX_CHARS,
  MAX_FILENAME_LENGTH,
  REMOTE_SCHEMA_VERSION,
  SHA256_HEX_PATTERN,
  UUID_PATTERN,
  VAULT_INDEX_BACKUP_FILENAME,
  VAULT_INDEX_FILENAME,
  VAULT_INDEX_SCHEMA_VERSION,
  clockFromRecord,
  clockFromTombstone,
  isRecord,
  isSha256Hex,
  isUuid,
  newVaultRevision,
} from './model';
export type {
  BlobContent,
  FileEntry,
  InlineContent,
  LegacyStorageItem,
  RemoteClock,
  RemoteFileContent,
  RemoteFileRecord,
  RemoteTombstone,
} from './model';

export {
  BLOB_OBJECT_ROOT,
  RTDB_LIVE_ROOT,
  RTDB_TOMBSTONE_ROOT,
  assertPathSegment,
  blobObjectPath,
  blobPathMatches,
  isSafePathSegment,
  parseBlobObjectPath,
  rtdbLivePath,
  rtdbLiveRoot,
  rtdbTombstonePath,
  rtdbTombstoneRoot,
} from './paths';
export type { ParsedBlobPath } from './paths';

export {
  isSafeLocalName,
  isVaultIndexName,
  isVaultMetadataName,
  isVaultTempName,
  mimeTypeFromName,
  sanitizePreferredName,
  splitStemExt,
  uniquifyLocalName,
  validateLocalName,
  vaultTempName,
} from './names';
export type { FilenameIssue, FilenameValidation, UniquifyOptions } from './names';

export {
  bytesToHex,
  classifyFileContent,
  containsNul,
  decodeUtf8Exact,
  hashAndClassify,
  sha256Digest,
  sha256Hex,
  utf8ByteLength,
  utf8Bytes,
} from './content';
export type { ContentPlacement } from './content';

export { clocksEqual, compareRemoteClock, winningRemote } from './conflicts';
export type { ReconcileAction, WinningRemote } from './conflicts';

export {
  isLegacyStorageItem,
  parseLiveChild,
  parseRemoteFileRecord,
  parseRemoteTombstone,
} from './parse';
export type {
  LiveChildParse,
  ParseFailure,
  ParseResult,
  ParseSuccess,
  RemoteParseContext,
} from './parse';

export { legacyMigrationRevision, legacyPreferredName, migrateLegacyStorageItem } from './legacy';

export {
  bindVaultIndexToOwner,
  clockFromAppliedRemote,
  clockFromAppliedTombstone,
  createEmptyVaultIndex,
  parseVaultIndex,
  parseVaultIndexText,
  serializeVaultIndex,
} from './index-schema';
export type {
  AppliedRemoteState,
  AppliedTombstone,
  PendingOpState,
  PendingOperation,
  PlatformFileIdentity,
  VaultIndex,
  VaultIndexEntry,
  VaultIndexLoadResult,
} from './index-schema';

export type {
  BlobUploadResult,
  CommitBytesInput,
  DeleteRecordInput,
  DirectChildSnapshot,
  ExpectedLocalEffect,
  IndexedVaultAdapter,
  LiveChildEvent,
  LocalVaultEvent,
  MutationOutcome,
  PublishRecordInput,
  RenameRecordInput,
  TombstoneEvent,
  Unsubscribe,
  VaultAdapter,
  VaultError,
  VaultIndexStore,
  VaultResult,
  VaultRootStatus,
  VaultSyncSnapshot,
  VaultTransport,
} from './contracts';

export {
  isPendingAcknowledged,
  isPendingSuperseded,
  latestPendingForId,
  markPending,
  newPendingOpId,
  recoverInFlightOperations,
  removePendingForId,
  removePendingOp,
  replacePendingForId,
} from './journal';

export {
  chooseLocalName,
  collectKnownIds,
  decideReconcile,
  isUniquifiedLocalName,
  rebindIndexNamesByIdentity,
  unmappedLocalNames,
} from './reconcile';
export type { ReconcileDecision, ReconcileInput } from './reconcile';

export { VaultSyncCoordinator, emptyVaultSyncSnapshot } from './coordinator';
export type {
  VaultRefreshOptions,
  VaultStartOptions,
  VaultSyncCommands,
  VaultDebugLog,
  VaultSyncOptions,
} from './coordinator';
