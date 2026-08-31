import { INLINE_TEXT_MAX_CHARS } from './model';

export type ContentPlacement =
  | { placement: 'inline'; text: string }
  | { placement: 'blob'; reason: 'invalid-utf8' | 'nul' | 'too-long' };

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8ByteLength(text: string): number {
  return utf8Bytes(text).byteLength;
}

export function decodeUtf8Exact(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function containsNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export async function sha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto is required to hash vault content.');
  }
  const digest = await subtle.digest('SHA-256', toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(await sha256Digest(bytes));
}

/**
 * Decide inline vs blob for exact bytes. Never trims. Inline only when the
 * payload is valid UTF-8, contains no NUL, and is within the character cap.
 */
export function classifyFileContent(bytes: Uint8Array): ContentPlacement {
  if (containsNul(bytes)) {
    return { placement: 'blob', reason: 'nul' };
  }
  const text = decodeUtf8Exact(bytes);
  if (text === null) {
    return { placement: 'blob', reason: 'invalid-utf8' };
  }
  if (text.length > INLINE_TEXT_MAX_CHARS) {
    return { placement: 'blob', reason: 'too-long' };
  }
  return { placement: 'inline', text };
}

export async function hashAndClassify(bytes: Uint8Array): Promise<{
  sha256: string;
  size: number;
  placement: ContentPlacement;
}> {
  const sha256 = await sha256Hex(bytes);
  return { sha256, size: bytes.byteLength, placement: classifyFileContent(bytes) };
}
