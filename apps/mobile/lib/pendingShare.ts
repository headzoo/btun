import type { SharePayload } from 'expo-sharing';
import { Platform } from 'react-native';
import { getSharedPayloads } from 'expo-sharing';
import { sanitizePreferredName } from '@yard-1/vault';

/** Stable identity for a share payload across auth/navigation remounts. */
export function sharePayloadIdentity(payload: SharePayload, index: number): string {
  return [index, payload.shareType, payload.mimeType ?? '', payload.value].join('\u0001');
}

/**
 * Process-wide guards so auth redirects / Strict Mode remounts do not
 * import the same payload twice before clearSharedPayloads().
 */
const inflightShareOps = new Set<string>();
const completedShareOps = new Set<string>();

export function beginShareOperation(key: string): boolean {
  if (completedShareOps.has(key) || inflightShareOps.has(key)) {
    return false;
  }
  inflightShareOps.add(key);
  return true;
}

export function completeShareOperation(key: string): void {
  inflightShareOps.delete(key);
  completedShareOps.add(key);
}

export function failShareOperation(key: string): void {
  inflightShareOps.delete(key);
}

export function isShareOperationComplete(key: string): boolean {
  return completedShareOps.has(key);
}

export function resetShareOperationGuards(): void {
  inflightShareOps.clear();
  completedShareOps.clear();
}

/** True when the OS has handed the app a share payload that is not yet cleared. */
export function hasPendingSharedPayloads(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    return getSharedPayloads().length > 0;
  } catch {
    return false;
  }
}

export function preferredNameForSharePayload(
  payload: SharePayload,
  index: number,
  originalName?: string | null,
): string {
  if (originalName) {
    return sanitizePreferredName(originalName, fallbackName(payload.shareType, index));
  }
  switch (payload.shareType) {
    case 'text':
      return sanitizePreferredName(
        index === 0 ? 'Shared Note.txt' : `Shared Note ${index + 1}.txt`,
      );
    case 'url':
      return sanitizePreferredName(
        index === 0 ? 'Shared Link.url' : `Shared Link ${index + 1}.url`,
      );
    case 'image':
      return sanitizePreferredName(
        guessNameFromUri(payload.value, `Shared Image ${index + 1}.jpg`),
      );
    case 'video':
      return sanitizePreferredName(
        guessNameFromUri(payload.value, `Shared Video ${index + 1}.mp4`),
      );
    case 'audio':
      return sanitizePreferredName(
        guessNameFromUri(payload.value, `Shared Audio ${index + 1}.m4a`),
      );
    case 'file':
    default:
      return sanitizePreferredName(guessNameFromUri(payload.value, `Shared File ${index + 1}`));
  }
}

function fallbackName(shareType: SharePayload['shareType'], index: number): string {
  switch (shareType) {
    case 'text':
      return index === 0 ? 'Shared Note.txt' : `Shared Note ${index + 1}.txt`;
    case 'url':
      return index === 0 ? 'Shared Link.url' : `Shared Link ${index + 1}.url`;
    case 'image':
      return `Shared Image ${index + 1}.jpg`;
    case 'video':
      return `Shared Video ${index + 1}.mp4`;
    case 'audio':
      return `Shared Audio ${index + 1}.m4a`;
    default:
      return `Shared File ${index + 1}`;
  }
}

function guessNameFromUri(uri: string, fallback: string): string {
  try {
    const withoutQuery = uri.split('?')[0] ?? uri;
    const segments = withoutQuery.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) {
      return fallback;
    }
    return decodeURIComponent(last);
  } catch {
    return fallback;
  }
}
