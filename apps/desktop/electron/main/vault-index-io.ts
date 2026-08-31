import fs from 'node:fs';
import path from 'node:path';
import {
  VAULT_INDEX_BACKUP_FILENAME,
  VAULT_INDEX_FILENAME,
  bindVaultIndexToOwner,
  createEmptyVaultIndex,
  parseVaultIndexText,
  serializeVaultIndex,
  vaultTempName,
  type VaultIndex,
  type VaultIndexLoadResult,
  type VaultResult,
} from '@yard-1/vault';
import { fail, forwardFail, ok } from './vault-paths';

export async function readVaultIndexText(root: string): Promise<string | null> {
  const indexPath = path.join(root, VAULT_INDEX_FILENAME);
  try {
    return await fs.promises.readFile(indexPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function loadVaultIndex(
  root: string,
  expectedUid: string,
): Promise<VaultIndexLoadResult> {
  let text: string | null;
  try {
    text = await readVaultIndexText(root);
  } catch (error) {
    return {
      status: 'corrupt',
      error: error instanceof Error ? error.message : 'Failed to read vault index.',
    };
  }
  if (text === null) {
    return { status: 'missing' };
  }
  const parsed = parseVaultIndexText(text);
  if (parsed.status !== 'ok') {
    return parsed;
  }
  return bindVaultIndexToOwner(parsed.index, expectedUid);
}

export async function backupCorruptIndex(root: string): Promise<void> {
  const indexPath = path.join(root, VAULT_INDEX_FILENAME);
  const backupPath = path.join(root, VAULT_INDEX_BACKUP_FILENAME);
  try {
    await fs.promises.rename(indexPath, backupPath);
  } catch {
    try {
      await fs.promises.copyFile(indexPath, backupPath);
      await fs.promises.unlink(indexPath);
    } catch {
      // Best-effort backup.
    }
  }
}

export async function writeVaultIndexAtomic(
  root: string,
  index: VaultIndex,
): Promise<VaultResult<VaultIndex>> {
  const indexPath = path.join(root, VAULT_INDEX_FILENAME);
  const tempPath = path.join(root, vaultTempName(`index-${process.pid}-${Date.now()}`));
  const payload = serializeVaultIndex(index);
  try {
    await fs.promises.writeFile(tempPath, payload, 'utf8');
    const fh = await fs.promises.open(tempPath, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tempPath, indexPath);
    return ok(index);
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // ignore
    }
    return fail('io', error instanceof Error ? error.message : 'Failed to write vault index.');
  }
}

export async function ensureOwnerIndex(
  root: string,
  uid: string,
): Promise<VaultResult<{ index: VaultIndex; load: VaultIndexLoadResult }>> {
  const load = await loadVaultIndex(root, uid);
  if (load.status === 'owner-mismatch') {
    return fail(
      'owner-mismatch',
      `Vault index belongs to another user (${load.ownerUid}); choose a different folder.`,
    );
  }
  if (load.status === 'unsupported-version') {
    return fail('unsupported', `Vault index version ${load.version} is not supported.`);
  }
  if (load.status === 'corrupt') {
    await backupCorruptIndex(root);
    const index = createEmptyVaultIndex(uid);
    const written = await writeVaultIndexAtomic(root, index);
    if (!written.ok) {
      return forwardFail(written);
    }
    return ok({ index: written.value, load });
  }
  if (load.status === 'missing') {
    const index = createEmptyVaultIndex(uid);
    const written = await writeVaultIndexAtomic(root, index);
    if (!written.ok) {
      return forwardFail(written);
    }
    return ok({ index: written.value, load });
  }
  return ok({ index: load.index, load });
}
