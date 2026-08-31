import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@yard-1/firebase';
import {
  emptyVaultSyncSnapshot,
  type VaultSyncCommands,
  type VaultSyncSnapshot,
} from '@yard-1/vault';

import { getMobileVaultAdapter } from '@/lib/vault/mobileVaultAdapter';
import { useMobileVaultLifecycle } from '@/lib/vault/mobileVaultLifecycle';
import { isNativeVaultPlatform } from '@/lib/vault/mobileVaultSettings';
import { startMobileVaultSync, stopMobileVaultSync } from '@/lib/vaultSync';

export interface UseVaultResult extends VaultSyncSnapshot {
  commands: VaultSyncCommands;
}

const idleCommands: VaultSyncCommands = {
  refresh: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  importBytes: async () => ({ id: '', localName: '' }),
};

/** Keep one coordinator alive while any useVault consumer is mounted. */
let vaultConsumerCount = 0;
let vaultConsumerUid: string | null = null;

export function useVault(): UseVaultResult {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<VaultSyncSnapshot>(emptyVaultSyncSnapshot);
  const adapter = isNativeVaultPlatform() ? getMobileVaultAdapter() : null;

  useMobileVaultLifecycle(adapter, { enabled: Boolean(user) });

  useEffect(() => {
    if (!user) {
      setSnapshot(emptyVaultSyncSnapshot());
      return;
    }

    let cancelled = false;
    let unsub: () => void = () => undefined;
    vaultConsumerCount += 1;
    vaultConsumerUid = user.uid;

    void startMobileVaultSync(user.uid)
      .then((coordinator) => {
        if (cancelled) {
          return;
        }
        unsub = coordinator.subscribe((next) => {
          if (!cancelled) {
            setSnapshot(next);
          }
        });
        setSnapshot(coordinator.getSnapshot());
      })
      .catch((error) => {
        if (!cancelled) {
          setSnapshot({
            ...emptyVaultSyncSnapshot(),
            rootStatus: {
              kind: 'error',
              message: error instanceof Error ? error.message : 'Failed to start vault sync.',
            },
          });
        }
      });

    return () => {
      cancelled = true;
      unsub();
      vaultConsumerCount = Math.max(0, vaultConsumerCount - 1);
      if (vaultConsumerCount === 0 && vaultConsumerUid === user.uid) {
        vaultConsumerUid = null;
        void stopMobileVaultSync();
      }
    };
  }, [user]);

  const commands = useMemo<VaultSyncCommands>(() => {
    if (!user) {
      return idleCommands;
    }
    return {
      refresh: () =>
        startMobileVaultSync(user.uid).then((coordinator) => coordinator.commands.refresh()),
      rename: (id, preferredName) =>
        startMobileVaultSync(user.uid).then((coordinator) =>
          coordinator.commands.rename(id, preferredName),
        ),
      remove: (id) =>
        startMobileVaultSync(user.uid).then((coordinator) => coordinator.commands.remove(id)),
      importBytes: (preferredName, bytes) =>
        startMobileVaultSync(user.uid).then((coordinator) =>
          coordinator.commands.importBytes(preferredName, bytes),
        ),
    };
  }, [user]);

  return { ...snapshot, commands };
}
