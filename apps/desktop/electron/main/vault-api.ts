import type {
  DirectChildSnapshot,
  ExpectedLocalEffect,
  FileEntry,
  LocalVaultEvent,
  VaultError,
  VaultIndex,
  VaultIndexLoadResult,
  VaultResult,
} from '@yard-1/vault';

export const BUDDY_TUNNEL_CHANNELS = {
  start: 'buddy-tunnel:start',
  stop: 'buddy-tunnel:stop',
  getStatus: 'buddy-tunnel:get-status',
  list: 'buddy-tunnel:list',
  listChildren: 'buddy-tunnel:list-children',
  loadIndex: 'buddy-tunnel:load-index',
  saveIndex: 'buddy-tunnel:save-index',
  configureRoot: 'buddy-tunnel:configure-root',
  useDefaultRoot: 'buddy-tunnel:use-default-root',
  importDroppedFiles: 'buddy-tunnel:import-paths',
  importClipboard: 'buddy-tunnel:import-clipboard',
  readBytes: 'buddy-tunnel:read-bytes',
  materialize: 'buddy-tunnel:materialize',
  writeAtomic: 'buddy-tunnel:write-atomic',
  rename: 'buddy-tunnel:rename',
  remove: 'buddy-tunnel:remove',
  open: 'buddy-tunnel:open',
  reveal: 'buddy-tunnel:reveal',
  revealRoot: 'buddy-tunnel:reveal-root',
  startDrag: 'buddy-tunnel:start-drag',
  registerExpectedEffect: 'buddy-tunnel:register-expected-effect',
  localEvent: 'buddy-tunnel:local-event',
} as const;

export type BuddyTunnelChannel = (typeof BUDDY_TUNNEL_CHANNELS)[keyof typeof BUDDY_TUNNEL_CHANNELS];

export const BUDDY_TUNNEL_INVOKE_CHANNELS: readonly string[] = Object.values(
  BUDDY_TUNNEL_CHANNELS,
).filter((channel) => channel !== BUDDY_TUNNEL_CHANNELS.localEvent);

export interface VaultStatus {
  running: boolean;
  uid: string | null;
  rootPath: string | null;
  rootDisplayName: string | null;
  usingDefaultRoot: boolean;
  indexStatus: VaultIndexLoadResult['status'] | 'idle';
  indexOwnerUid?: string;
}

export interface ImportedFileResult {
  sourcePath: string;
  localName: string;
  size: number;
}

export interface MaterializeInput {
  localName: string;
  bytes: Uint8Array;
  id?: string;
}

export interface RenameInput {
  from: string;
  to: string;
}

export interface BuddyTunnelApi {
  start(uid: string): Promise<VaultResult<VaultStatus>>;
  stop(): Promise<VaultResult<VaultStatus>>;
  getStatus(): Promise<VaultResult<VaultStatus>>;
  list(): Promise<VaultResult<FileEntry[]>>;
  listDirectChildren(): Promise<VaultResult<DirectChildSnapshot[]>>;
  loadIndex(): Promise<VaultResult<VaultIndexLoadResult>>;
  saveIndex(index: VaultIndex): Promise<VaultResult<void>>;
  configureRoot(): Promise<VaultResult<VaultStatus>>;
  useDefaultRoot(): Promise<VaultResult<VaultStatus>>;
  importDroppedFiles(files: File[]): Promise<VaultResult<ImportedFileResult[]>>;
  importClipboard(): Promise<VaultResult<ImportedFileResult[]>>;
  readBytes(localName: string): Promise<VaultResult<Uint8Array>>;
  materialize(input: MaterializeInput): Promise<VaultResult<DirectChildSnapshot>>;
  writeAtomic(localName: string, bytes: Uint8Array): Promise<VaultResult<DirectChildSnapshot>>;
  rename(input: RenameInput): Promise<VaultResult<DirectChildSnapshot>>;
  remove(localName: string): Promise<VaultResult<void>>;
  open(localName: string): Promise<VaultResult<void>>;
  reveal(localName: string): Promise<VaultResult<void>>;
  revealRoot(): Promise<VaultResult<void>>;
  startDrag(localName: string): Promise<VaultResult<void>>;
  registerExpectedEffect(effect: ExpectedLocalEffect): Promise<VaultResult<void>>;
  onLocalChange(listener: (event: LocalVaultEvent) => void): () => void;
}

export type {
  DirectChildSnapshot,
  ExpectedLocalEffect,
  FileEntry,
  LocalVaultEvent,
  VaultError,
  VaultResult,
};
