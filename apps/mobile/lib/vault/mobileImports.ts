import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  sanitizePreferredName,
  utf8Bytes,
  type DirectChildSnapshot,
  type VaultResult,
} from '@yard-1/vault';

import type { MobileVaultAdapter } from './mobileVaultAdapter';
import { requestVaultRescan } from './mobileVaultEvents';
import { fail, ok } from './mobileVaultSettings';

export interface ImportedVaultFile {
  sourceUri: string;
  localName: string;
  size: number;
}

function preferredNameFromUri(uri: string, fallback: string): string {
  try {
    const withoutQuery = uri.split('?')[0] ?? uri;
    const segments = withoutQuery.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? fallback;
    return sanitizePreferredName(decodeURIComponent(last), fallback);
  } catch {
    return sanitizePreferredName(fallback);
  }
}

/**
 * Copy a readable/cached URI into the active vault as a real file.
 * Does not clear incoming shares — callers own share lifecycle.
 */
export async function importUriIntoVault(
  adapter: MobileVaultAdapter,
  uri: string,
  preferredName?: string,
): Promise<VaultResult<ImportedVaultFile>> {
  if (Platform.OS === 'web') {
    return fail('unsupported', 'Vault import is not available on web.');
  }

  try {
    const source = new File(uri);
    if (!source.exists) {
      return fail('not-found', 'Selected file is not readable.');
    }
    const bytes = await source.bytes();
    const name = preferredName
      ? sanitizePreferredName(preferredName)
      : preferredNameFromUri(uri, source.name || 'file');
    const written = await adapter.importBytes(name, bytes);
    if (!written.ok) {
      return written;
    }
    requestVaultRescan('import');
    return ok({
      sourceUri: uri,
      localName: written.value.name,
      size: written.value.size,
    });
  } catch (error) {
    return fail(
      'io',
      error instanceof Error ? error.message : 'Failed to import file into the vault.',
    );
  }
}

/**
 * Open the Expo document picker and copy selected assets into the vault.
 * Uses copyToCacheDirectory so FileSystem can read immediately (Expo 57).
 */
export async function pickAndImportDocuments(
  adapter: MobileVaultAdapter,
  options?: { multiple?: boolean; type?: string | string[] },
): Promise<VaultResult<ImportedVaultFile[]>> {
  if (Platform.OS === 'web') {
    return fail('unsupported', 'Document picking is not available on web vault builds.');
  }

  let result: DocumentPicker.DocumentPickerResult;
  try {
    result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: options?.multiple === true,
      type: options?.type ?? '*/*',
    });
  } catch (error) {
    return fail('permission', error instanceof Error ? error.message : 'Document picker failed.');
  }

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return ok([]);
  }

  const imported: ImportedVaultFile[] = [];
  const errors: string[] = [];

  for (const asset of result.assets) {
    const one = await importUriIntoVault(adapter, asset.uri, asset.name);
    if (one.ok) {
      imported.push(one.value);
    } else {
      errors.push(`${asset.name}: ${one.error.message}`);
    }
  }

  requestVaultRescan('picker');

  if (imported.length === 0 && errors.length > 0) {
    return fail('io', errors.join('; '));
  }
  if (errors.length > 0) {
    return fail('io', `Imported ${imported.length} file(s); failed: ${errors.join('; ')}`);
  }
  return ok(imported);
}

/**
 * Persist shared/imported text as a real UTF-8 vault file (not RTDB-only).
 */
export async function importTextAsVaultFile(
  adapter: MobileVaultAdapter,
  text: string,
  preferredName = 'Note.txt',
): Promise<VaultResult<DirectChildSnapshot>> {
  const name = sanitizePreferredName(preferredName, 'Note.txt');
  const bytes = utf8Bytes(text);
  const written = await adapter.importBytes(name, bytes);
  if (written.ok) {
    requestVaultRescan('share');
  }
  return written;
}
