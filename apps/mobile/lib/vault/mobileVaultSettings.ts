import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { VaultError, VaultResult } from '@yard-1/vault';

export const DEFAULT_VAULT_FOLDER_NAME = 'Buddy Tunnel';
export const SETTINGS_FILENAME = '.buddy-tunnel-settings.json';

export type MobileVaultRootKind = 'app-documents' | 'selected';

/**
 * Durable root preference stored under app Documents (outside the vault).
 * Selected roots keep a URI/permission descriptor; app Documents is the default.
 */
export interface MobileVaultRootSettings {
  kind: MobileVaultRootKind;
  /** Stable key for the active root (`default` or a URI/descriptor). */
  descriptor: string;
  /** Selected directory URI when kind === 'selected'. */
  uri?: string;
  displayName?: string;
  /**
   * When true, `.buddy-tunnel.json` is stored under app Documents keyed by descriptor
   * because the selected root cannot safely hold the index.
   */
  indexInAppDocuments?: boolean;
}

export interface MobileVaultStatus {
  running: boolean;
  uid: string | null;
  rootUri: string | null;
  rootDisplayName: string | null;
  usingDefaultRoot: boolean;
  indexInAppDocuments: boolean;
  indexStatus: 'idle' | 'ok' | 'missing' | 'corrupt' | 'unsupported-version' | 'owner-mismatch';
  indexOwnerUid?: string;
  platform: typeof Platform.OS;
}

export function fail<T = never>(code: VaultError['code'], message: string): VaultResult<T> {
  return { ok: false, error: { code, message } };
}

export function ok<T>(value: T): VaultResult<T> {
  return { ok: true, value };
}

export function defaultRootSettings(): MobileVaultRootSettings {
  return {
    kind: 'app-documents',
    descriptor: 'default',
    displayName: DEFAULT_VAULT_FOLDER_NAME,
    indexInAppDocuments: false,
  };
}

function settingsFile(): File {
  return new File(Paths.document, SETTINGS_FILENAME);
}

export function isNativeVaultPlatform(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

export function defaultVaultDirectory(): Directory {
  return new Directory(Paths.document, DEFAULT_VAULT_FOLDER_NAME);
}

export async function ensureDefaultVaultDirectory(): Promise<VaultResult<Directory>> {
  if (!isNativeVaultPlatform()) {
    return fail('unsupported', 'Vault filesystem is only available on iOS and Android.');
  }
  try {
    const dir = defaultVaultDirectory();
    if (!dir.exists) {
      dir.create({ intermediates: true, idempotent: true });
    }
    if (!dir.exists) {
      return fail('io', 'Failed to create the Buddy Tunnel documents directory.');
    }
    return ok(dir);
  } catch (error) {
    return fail(
      'io',
      error instanceof Error ? error.message : 'Failed to create the Buddy Tunnel directory.',
    );
  }
}

export async function loadVaultRootSettings(): Promise<MobileVaultRootSettings> {
  if (!isNativeVaultPlatform()) {
    return defaultRootSettings();
  }
  try {
    const file = settingsFile();
    if (!file.exists) {
      return defaultRootSettings();
    }
    const text = await file.text();
    if (!text.trim()) {
      return defaultRootSettings();
    }
    const parsed = JSON.parse(text) as Partial<MobileVaultRootSettings>;
    if (parsed.kind === 'selected' && typeof parsed.uri === 'string' && parsed.uri.length > 0) {
      return {
        kind: 'selected',
        descriptor: typeof parsed.descriptor === 'string' ? parsed.descriptor : parsed.uri,
        uri: parsed.uri,
        displayName:
          typeof parsed.displayName === 'string' ? parsed.displayName : DEFAULT_VAULT_FOLDER_NAME,
        indexInAppDocuments: parsed.indexInAppDocuments === true,
      };
    }
    return defaultRootSettings();
  } catch {
    return defaultRootSettings();
  }
}

export async function saveVaultRootSettings(
  settings: MobileVaultRootSettings,
): Promise<VaultResult<void>> {
  if (!isNativeVaultPlatform()) {
    return fail('unsupported', 'Vault settings are only available on iOS and Android.');
  }
  try {
    const file = settingsFile();
    const payload = `${JSON.stringify(settings, null, 2)}\n`;
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(payload);
    return ok(undefined);
  } catch (error) {
    return fail(
      'io',
      error instanceof Error ? error.message : 'Failed to persist vault root settings.',
    );
  }
}

/** Stable filename fragment for sidecar indexes keyed by root descriptor. */
export function indexSidecarBasename(descriptor: string): string {
  let hash = 0;
  for (let i = 0; i < descriptor.length; i += 1) {
    hash = (hash * 31 + descriptor.charCodeAt(i)) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `.buddy-tunnel-index.${hex}.json`;
}

export function indexSidecarFile(descriptor: string): File {
  return new File(Paths.document, indexSidecarBasename(descriptor));
}

export function indexBackupSidecarFile(descriptor: string): File {
  return new File(Paths.document, `${indexSidecarBasename(descriptor)}.bak`);
}
