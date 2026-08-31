import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeLocalName,
  isVaultMetadataName,
  type VaultError,
  type VaultResult,
} from '@yard-1/vault';

export const DEFAULT_VAULT_FOLDER_NAME = 'Buddy Tunnel';

export function fail<T = never>(code: VaultError['code'], message: string): VaultResult<T> {
  return { ok: false, error: { code, message } };
}

export function ok<T>(value: T): VaultResult<T> {
  return { ok: true, value };
}

/** Re-wrap a failed result under a different success type. */
export function forwardFail<T>(result: { ok: false; error: VaultError }): VaultResult<T> {
  return result;
}

export function resolveDefaultVaultRoot(documentsPath: string, homePath: string): string {
  const documents = documentsPath.trim();
  if (documents.length > 0) {
    return path.join(documents, DEFAULT_VAULT_FOLDER_NAME);
  }
  return path.join(homePath, DEFAULT_VAULT_FOLDER_NAME);
}

export function canonicalizePath(target: string): string {
  return path.resolve(target);
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootCanon = canonicalizePath(root);
  const candidateCanon = canonicalizePath(candidate);
  if (process.platform === 'win32') {
    const rootFolded = rootCanon.toLowerCase();
    const candidateFolded = candidateCanon.toLowerCase();
    if (candidateFolded === rootFolded) {
      return true;
    }
    const prefix = rootFolded.endsWith(path.sep) ? rootFolded : `${rootFolded}${path.sep}`;
    return candidateFolded.startsWith(prefix);
  }
  if (candidateCanon === rootCanon) {
    return true;
  }
  const prefix = rootCanon.endsWith(path.sep) ? rootCanon : `${rootCanon}${path.sep}`;
  return candidateCanon.startsWith(prefix);
}

export function validateDirectChildName(name: string): VaultResult<string> {
  if (!isSafeLocalName(name) || isVaultMetadataName(name)) {
    return fail('unsafe-name', `Unsafe local name: ${name}`);
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return fail('unsafe-name', `Unsafe local name: ${name}`);
  }
  if (path.basename(name) !== name) {
    return fail('unsafe-name', `Unsafe local name: ${name}`);
  }
  return ok(name);
}

/**
 * Resolve a validated direct-child basename under a canonical vault root.
 * Rejects path escapes, separators, and empty names before touching the filesystem.
 */
export function resolveVaultChildPath(root: string, name: string): VaultResult<string> {
  const validated = validateDirectChildName(name);
  if (!validated.ok) {
    return validated;
  }
  const rootCanon = canonicalizePath(root);
  const child = path.join(rootCanon, validated.value);
  const childCanon = canonicalizePath(child);
  if (!isPathInsideRoot(rootCanon, childCanon) || path.dirname(childCanon) !== rootCanon) {
    return fail('path-escape', 'Resolved path escapes the vault root.');
  }
  return ok(childCanon);
}

export function isIgnoredVaultChildName(name: string): boolean {
  return isVaultMetadataName(name);
}

export function lstatSafe(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

export function isEligibleVaultFile(stats: fs.Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

export async function ensureDirectory(target: string): Promise<VaultResult<string>> {
  const canon = canonicalizePath(target);
  try {
    await fs.promises.mkdir(canon, { recursive: true });
    const stats = await fs.promises.lstat(canon);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return fail('not-a-file', 'Vault root must be a real directory.');
    }
    return ok(canon);
  } catch (error) {
    return fail('io', error instanceof Error ? error.message : 'Failed to create vault root.');
  }
}
