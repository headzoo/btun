import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@yard-1/firebase';
import {
  emptyVaultSyncSnapshot,
  type VaultSyncCommands,
  type VaultSyncSnapshot,
} from '@yard-1/vault';

import {
  changeDesktopVaultRoot,
  startDesktopVaultSync,
  stopDesktopVaultSync,
} from '@/lib/vaultSync';
import { verboseLog } from '@/lib/verbose';

export interface UseVaultResult extends VaultSyncSnapshot {
  commands: VaultSyncCommands & {
    changeRoot: (mode: 'choose' | 'default') => Promise<void>;
  };
}

const idleCommands: UseVaultResult['commands'] = {
  refresh: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  importBytes: async () => ({ id: '', localName: '' }),
  changeRoot: async () => undefined,
};

export function useVault(): UseVaultResult {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<VaultSyncSnapshot>(emptyVaultSyncSnapshot);
  const unsubRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!user) {
      verboseLog('vault', 'no auth user; stopping vault sync');
      unsubRef.current();
      unsubRef.current = () => undefined;
      void stopDesktopVaultSync();
      setSnapshot(emptyVaultSyncSnapshot());
      return;
    }

    let cancelled = false;
    verboseLog('vault', 'auth user present; starting vault sync', { uid: user.uid });

    const syncHooks = {
      onSnapshot: (next: VaultSyncSnapshot) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      },
      onSubscribe: (unsubscribe: () => void) => {
        unsubRef.current();
        unsubRef.current = unsubscribe;
      },
    };

    void (async () => {
      try {
        await startDesktopVaultSync(user.uid, syncHooks);
      } catch (error) {
        if (!cancelled) {
          verboseLog('vault', 'startDesktopVaultSync failed', error);
          const code =
            error && typeof error === 'object' && 'code' in error
              ? String((error as { code?: unknown }).code)
              : undefined;
          if (code === 'owner-mismatch') {
            setSnapshot({
              ...emptyVaultSyncSnapshot(),
              rootStatus: {
                kind: 'owner-mismatch',
                message:
                  error instanceof Error ? error.message : 'Vault belongs to another account.',
              },
            });
            return;
          }
          setSnapshot({
            ...emptyVaultSyncSnapshot(),
            rootStatus: {
              kind: 'error',
              message: error instanceof Error ? error.message : 'Failed to start vault sync.',
            },
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubRef.current();
      unsubRef.current = () => undefined;
      void stopDesktopVaultSync();
    };
  }, [user]);

  const commands = useMemo<UseVaultResult['commands']>(() => {
    if (!user) {
      return idleCommands;
    }
    return {
      refresh: (options) =>
        startDesktopVaultSync(user.uid).then((coordinator) =>
          coordinator.commands.refresh(options),
        ),
      rename: (id, preferredName) =>
        startDesktopVaultSync(user.uid).then((coordinator) =>
          coordinator.commands.rename(id, preferredName),
        ),
      remove: (id) =>
        startDesktopVaultSync(user.uid).then((coordinator) => coordinator.commands.remove(id)),
      importBytes: (preferredName, bytes) =>
        startDesktopVaultSync(user.uid).then((coordinator) =>
          coordinator.commands.importBytes(preferredName, bytes),
        ),
      changeRoot: async (mode) => {
        await changeDesktopVaultRoot(mode, user.uid);
        await startDesktopVaultSync(user.uid, {
          onSnapshot: (next) => {
            setSnapshot(next);
          },
          onSubscribe: (unsubscribe) => {
            unsubRef.current();
            unsubRef.current = unsubscribe;
          },
        });
      },
    };
  }, [user]);

  return { ...snapshot, commands };
}
