import { createFirebaseVaultTransport } from '@yard-1/firebase';
import {
  emptyVaultSyncSnapshot,
  VaultSyncCoordinator,
  type Unsubscribe,
  type VaultSyncSnapshot,
} from '@yard-1/vault';

import { getMobileVaultAdapter } from '@/lib/vault/mobileVaultAdapter';
import { isNativeVaultPlatform } from '@/lib/vault/mobileVaultSettings';

let generation = 0;
let active: { uid: string; coordinator: VaultSyncCoordinator } | null = null;

export function getMobileVaultCoordinator(): VaultSyncCoordinator | null {
  return active?.coordinator ?? null;
}

export function subscribeMobileVault(listener: (snapshot: VaultSyncSnapshot) => void): Unsubscribe {
  if (!active) {
    listener(emptyVaultSyncSnapshot());
    return () => undefined;
  }
  return active.coordinator.subscribe(listener);
}

export async function startMobileVaultSync(uid: string): Promise<VaultSyncCoordinator> {
  if (active?.uid === uid) {
    return active.coordinator;
  }
  await stopMobileVaultSync();
  const started = ++generation;

  if (!isNativeVaultPlatform()) {
    throw new Error('Vault sync requires a native iOS or Android runtime.');
  }

  const adapter = getMobileVaultAdapter();
  const startedVault = await adapter.start(uid);
  if (!startedVault.ok) {
    throw new Error(startedVault.error.message);
  }
  if (started !== generation) {
    await adapter.stop();
    throw new Error('Vault sync generation changed during start.');
  }

  const coordinator = new VaultSyncCoordinator({
    adapter,
    transport: createFirebaseVaultTransport(uid),
  });
  active = { uid, coordinator };
  try {
    await coordinator.start();
  } catch (error) {
    if (started === generation) {
      await stopMobileVaultSync();
    }
    throw error;
  }
  if (started !== generation) {
    await coordinator.stop();
    return startMobileVaultSync(uid);
  }
  return coordinator;
}

export async function stopMobileVaultSync(): Promise<void> {
  generation += 1;
  const current = active;
  active = null;
  if (!current) {
    return;
  }
  await current.coordinator.stop();
  await getMobileVaultAdapter().stop();
}

export async function restartMobileVaultSync(): Promise<VaultSyncCoordinator | null> {
  const uid = active?.uid;
  if (!uid) {
    return null;
  }
  await stopMobileVaultSync();
  return startMobileVaultSync(uid);
}
