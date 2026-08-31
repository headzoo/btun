import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { Platform } from 'react-native';

import type { FileEntry, VaultResult } from '@yard-1/vault';

import { getMobileVaultAdapter } from './mobileVaultAdapter';
import { fail, ok } from './mobileVaultSettings';

/**
 * Open/share a ready vault file via the native share / open-in sheet.
 * Expo 57 has no portable registered-app opener without extra deps; shareAsync
 * is the approved open-in fallback.
 */
export async function openVaultFile(entry: FileEntry): Promise<VaultResult<void>> {
  if (Platform.OS === 'web') {
    return fail('unsupported', 'Opening vault files requires the iOS or Android app.');
  }
  if (entry.status !== 'ready') {
    return fail(
      'io',
      entry.status === 'pending'
        ? 'Wait until the file finishes syncing before opening it.'
        : (entry.errorMessage ?? 'This file is not ready to open.'),
    );
  }

  const resolved = getMobileVaultAdapter().resolveLocalFile(entry.localName);
  if (!resolved.ok) {
    return resolved;
  }

  try {
    if (!(await isAvailableAsync())) {
      return fail('unsupported', 'Native share/open is not available on this device.');
    }
    await shareAsync(resolved.value.uri, {
      mimeType: entry.mimeType || resolved.value.mimeType || undefined,
      dialogTitle: entry.localName,
    });
    return ok(undefined);
  } catch (error) {
    return fail('io', error instanceof Error ? error.message : 'Failed to open or share the file.');
  }
}
