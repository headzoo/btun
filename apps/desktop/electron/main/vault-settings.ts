import fs from 'node:fs';
import path from 'node:path';
import { fail, ok } from './vault-paths';
import type { VaultResult } from '@yard-1/vault';

export interface VaultSettings {
  selectedRoot: string | null;
}

const SETTINGS_FILENAME = 'buddy-tunnel-vault.json';

export function vaultSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, SETTINGS_FILENAME);
}

export function loadVaultSettings(userDataPath: string): VaultSettings {
  const filePath = vaultSettingsPath(userDataPath);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'selectedRoot' in parsed &&
      (typeof (parsed as VaultSettings).selectedRoot === 'string' ||
        (parsed as VaultSettings).selectedRoot === null)
    ) {
      const selectedRoot = (parsed as VaultSettings).selectedRoot;
      return {
        selectedRoot:
          typeof selectedRoot === 'string' && selectedRoot.trim().length > 0
            ? path.resolve(selectedRoot)
            : null,
      };
    }
  } catch {
    // Missing or corrupt settings fall back to defaults.
  }
  return { selectedRoot: null };
}

export function saveVaultSettings(
  userDataPath: string,
  settings: VaultSettings,
): VaultResult<VaultSettings> {
  const filePath = vaultSettingsPath(userDataPath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload: VaultSettings = {
    selectedRoot:
      typeof settings.selectedRoot === 'string' && settings.selectedRoot.trim().length > 0
        ? path.resolve(settings.selectedRoot)
        : null,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const fd = fs.openSync(tempPath, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    return ok(payload);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    return fail('io', error instanceof Error ? error.message : 'Failed to save vault settings.');
  }
}
