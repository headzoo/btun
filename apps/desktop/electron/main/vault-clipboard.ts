import { clipboard } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, ok } from './vault-paths';
import type { VaultResult } from '@yard-1/vault';

function decodeUtf16Le(buffer: Buffer): string {
  let text = buffer.toString('utf16le');
  while (text.endsWith('\0')) {
    text = text.slice(0, -1);
  }
  return text;
}

function uniqueExistingPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function parseUriList(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    try {
      if (trimmed.startsWith('file:')) {
        paths.push(fileURLToPath(trimmed));
      }
    } catch {
      // ignore malformed URI
    }
  }
  return paths;
}

/**
 * Narrow OS-specific clipboard file-list parsing. Returns unsupported when the
 * current desktop environment does not expose a safe file list format.
 */
export function readClipboardFilePaths(): VaultResult<string[]> {
  try {
    if (process.platform === 'darwin') {
      const formats = clipboard.availableFormats();
      if (formats.includes('public.file-url')) {
        const buf = clipboard.readBuffer('public.file-url');
        const text = buf.toString('utf8');
        const paths = parseUriList(text.includes('://') ? text : `file://${text}`);
        if (paths.length > 0) {
          return ok(uniqueExistingPaths(paths));
        }
      }
      if (formats.includes('NSFilenamesPboardType')) {
        const text = clipboard.read('NSFilenamesPboardType');
        // Electron may surface a plist-ish or newline list depending on version.
        const paths = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('/'));
        if (paths.length > 0) {
          return ok(uniqueExistingPaths(paths));
        }
      }
      const uriText = clipboard.read('text/uri-list');
      if (uriText) {
        const paths = parseUriList(uriText);
        if (paths.length > 0) {
          return ok(uniqueExistingPaths(paths));
        }
      }
      return fail('unsupported', 'Clipboard does not contain a usable file list on macOS.');
    }

    if (process.platform === 'win32') {
      const formats = clipboard.availableFormats();
      if (formats.includes('CF_HDROP')) {
        const buf = clipboard.readBuffer('CF_HDROP');
        // DROPFILES header is 20 bytes; file list is double-null-terminated UTF-16.
        if (buf.length > 20) {
          const offset = buf.readUInt32LE(0);
          const start = offset > 0 && offset < buf.length ? offset : 20;
          const body = decodeUtf16Le(buf.subarray(start));
          const paths = body.split('\u0000').filter((item) => item.length > 0);
          if (paths.length > 0) {
            return ok(uniqueExistingPaths(paths));
          }
        }
      }
      return fail('unsupported', 'Clipboard does not contain a usable file list on Windows.');
    }

    // Linux / others: text/uri-list is the common safe format.
    const formats = clipboard.availableFormats();
    if (formats.includes('text/uri-list')) {
      const text = clipboard.read('text/uri-list');
      const paths = parseUriList(text);
      if (paths.length > 0) {
        return ok(uniqueExistingPaths(paths));
      }
    }
    const plain = clipboard.readText();
    if (plain.includes('file:')) {
      const paths = parseUriList(plain);
      if (paths.length > 0) {
        return ok(uniqueExistingPaths(paths));
      }
    }
    return fail('unsupported', 'Clipboard does not contain a usable file list.');
  } catch (error) {
    return fail(
      'unsupported',
      error instanceof Error ? error.message : 'Failed to read clipboard file list.',
    );
  }
}
