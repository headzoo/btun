import { MAX_FILENAME_LENGTH, VAULT_INDEX_BACKUP_FILENAME, VAULT_INDEX_FILENAME } from './model';

const WINDOWS_RESERVED_PATTERN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/;
const VAULT_TEMP_PATTERN = /^\.buddy-tunnel\..+\.tmp$/;

export type FilenameIssue =
  | 'empty'
  | 'too-long'
  | 'dot-or-dotdot'
  | 'separator-or-illegal'
  | 'trailing-dot-or-space'
  | 'windows-reserved'
  | 'index-or-temp';

export type FilenameValidation = { ok: true; name: string } | { ok: false; issue: FilenameIssue };

function hasIllegalFilenameChars(name: string): boolean {
  if (UNSAFE_FILENAME_CHARS.test(name)) {
    return true;
  }
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

export function isVaultIndexName(name: string): boolean {
  return name === VAULT_INDEX_FILENAME || name === VAULT_INDEX_BACKUP_FILENAME;
}

export function isVaultTempName(name: string): boolean {
  return VAULT_TEMP_PATTERN.test(name);
}

export function isVaultMetadataName(name: string): boolean {
  return isVaultIndexName(name) || isVaultTempName(name);
}

function replaceIllegalFilenameChars(name: string, replacement = '_'): string {
  let out = '';
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i] ?? '';
    if (ch.charCodeAt(0) < 32 || UNSAFE_FILENAME_CHARS.test(ch)) {
      out += replacement;
    } else {
      out += ch;
    }
  }
  return out;
}

export function vaultTempName(token: string): string {
  const safe = replaceIllegalFilenameChars(token).replace(/^\.+/, '').slice(0, 80);
  if (!safe) {
    throw new Error('Temporary name token must not be empty.');
  }
  return `.buddy-tunnel.${safe}.tmp`;
}

export function splitStemExt(name: string): { stem: string; ext: string } {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { stem: name, ext: '' };
  }
  return { stem: name.slice(0, lastDot), ext: name.slice(lastDot) };
}

function truncateToLength(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  let end = max;
  if (end > 0 && (value.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function validateLocalName(name: string): FilenameValidation {
  if (name.length === 0) {
    return { ok: false, issue: 'empty' };
  }
  if (name.length > MAX_FILENAME_LENGTH) {
    return { ok: false, issue: 'too-long' };
  }
  if (name === '.' || name === '..') {
    return { ok: false, issue: 'dot-or-dotdot' };
  }
  if (hasIllegalFilenameChars(name)) {
    return { ok: false, issue: 'separator-or-illegal' };
  }
  if (name.endsWith(' ') || name.endsWith('.')) {
    return { ok: false, issue: 'trailing-dot-or-space' };
  }
  if (WINDOWS_RESERVED_PATTERN.test(name)) {
    return { ok: false, issue: 'windows-reserved' };
  }
  if (isVaultMetadataName(name)) {
    return { ok: false, issue: 'index-or-temp' };
  }
  return { ok: true, name };
}

export function isSafeLocalName(name: string): boolean {
  return validateLocalName(name).ok;
}

export function sanitizePreferredName(name: string, fallback = 'file'): string {
  let next = replaceIllegalFilenameChars(name.normalize('NFC'));
  next = next.replace(/[ .]+$/g, '');
  next = next.replace(/^\.+$/g, '');
  if (!next) {
    next = fallback;
  }
  if (
    WINDOWS_RESERVED_PATTERN.test(next) ||
    isVaultMetadataName(next) ||
    next === '.' ||
    next === '..'
  ) {
    next = `_${next}`;
  }
  next = truncateToLength(next, MAX_FILENAME_LENGTH);
  next = next.replace(/[ .]+$/g, '');
  const validated = validateLocalName(next);
  if (validated.ok) {
    return validated.name;
  }
  return fallback;
}

function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export interface UniquifyOptions {
  /** When true, `Report.pdf` and `report.pdf` may coexist. Default false. */
  caseSensitive?: boolean;
}

/**
 * Return a unique direct-child name for this device. Never writes per-device
 * suffixes back to RTDB; callers keep the preferred remote name unchanged.
 */
export function uniquifyLocalName(
  preferredName: string,
  existingNames: Iterable<string>,
  options?: UniquifyOptions,
): string {
  const caseSensitive = options?.caseSensitive === true;
  const occupied = new Set<string>();
  for (const existing of existingNames) {
    occupied.add(caseSensitive ? existing : foldName(existing));
  }

  const preferred = isSafeLocalName(preferredName)
    ? preferredName
    : sanitizePreferredName(preferredName);

  const isOccupied = (candidate: string): boolean =>
    occupied.has(caseSensitive ? candidate : foldName(candidate));

  if (!isOccupied(preferred)) {
    return preferred;
  }

  const { stem, ext } = splitStemExt(preferred);
  for (let n = 2; n < 1_000_000; n += 1) {
    const suffix = `.${n}`;
    const budget = MAX_FILENAME_LENGTH - suffix.length - ext.length;
    if (budget < 1) {
      break;
    }
    const candidate = `${truncateToLength(stem, budget)}${suffix}${ext}`;
    if (isSafeLocalName(candidate) && !isOccupied(candidate)) {
      return candidate;
    }
  }

  throw new Error('Could not allocate a unique local filename.');
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
};

export function mimeTypeFromName(name: string): string {
  const { ext } = splitStemExt(name);
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}
