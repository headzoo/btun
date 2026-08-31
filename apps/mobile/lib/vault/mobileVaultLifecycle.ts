import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { MobileVaultAdapter } from './mobileVaultAdapter';
import { subscribeVaultRescanRequests, type VaultRescanReason } from './mobileVaultEvents';

export type { VaultRescanReason } from './mobileVaultEvents';
export { requestVaultRescan, subscribeVaultRescanRequests } from './mobileVaultEvents';

/**
 * While the vault is active, rescan on AppState→active, screen focus, and
 * explicit import/share/picker/root notifications. No background watching.
 */
export function useMobileVaultLifecycle(
  adapter: MobileVaultAdapter | null,
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled !== false;

  useEffect(() => {
    if (!enabled || !adapter) {
      return;
    }

    const onAppState = (next: AppStateStatus) => {
      if (next === 'active') {
        void adapter.rescan('app-active');
      }
    };

    const appSub = AppState.addEventListener('change', onAppState);
    const requestUnsub = subscribeVaultRescanRequests((_reason: VaultRescanReason) => {
      void adapter.rescan(_reason);
    });

    return () => {
      appSub.remove();
      requestUnsub();
    };
  }, [adapter, enabled]);

  useFocusEffect(
    useCallback(() => {
      if (!enabled || !adapter) {
        return;
      }
      void adapter.rescan('focus');
    }, [adapter, enabled]),
  );
}
