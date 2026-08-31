import { createFirebaseVaultTransport } from '@yard-1/firebase';
import {
  emptyVaultSyncSnapshot,
  VaultSyncCoordinator,
  type Unsubscribe,
  type VaultSyncSnapshot,
} from '@yard-1/vault';

import { createDesktopVaultAdapter } from '@/lib/desktopVaultAdapter';

let generation = 0;
let active: {
  uid: string;
  coordinator: VaultSyncCoordinator;
  generation: number;
} | null = null;

function caseSensitiveNames(): boolean {
  return typeof navigator !== 'undefined' && /linux/i.test(navigator.platform);
}

export function getDesktopVaultCoordinator(): VaultSyncCoordinator | null {
  return active?.coordinator ?? null;
}

export function subscribeDesktopVault(
  listener: (snapshot: VaultSyncSnapshot) => void,
): Unsubscribe {
  if (!active) {
    listener(emptyVaultSyncSnapshot());
    return () => undefined;
  }
  return active.coordinator.subscribe(listener);
}

export interface DesktopVaultSyncHooks {
  onSnapshot?: (snapshot: VaultSyncSnapshot) => void;
  /** Called as soon as the coordinator is subscribed — before bootstrap finishes. */
  onSubscribe?: (unsubscribe: Unsubscribe) => void;
}

export async function startDesktopVaultSync(
  uid: string,
  hooks?: DesktopVaultSyncHooks,
): Promise<VaultSyncCoordinator> {
  if (active?.uid === uid) {
    if (hooks?.onSnapshot) {
      const unsubscribe = active.coordinator.subscribe(hooks.onSnapshot);
      hooks.onSubscribe?.(unsubscribe);
    }
    return active.coordinator;
  }
  await stopDesktopVaultSync();
  const started = ++generation;

  const startedVault = await window.buddyTunnel.start(uid);
  if (!startedVault.ok) {
    // Retain a recovery handle when main kept the uid (e.g. IO failure after bind).
    throw Object.assign(new Error(startedVault.error.message), {
      code: startedVault.error.code,
    });
  }
  if (started !== generation) {
    await window.buddyTunnel.stop();
    throw new Error('Vault sync generation changed during start.');
  }

  const adapter = createDesktopVaultAdapter();
  const coordinator = new VaultSyncCoordinator({
    adapter,
    transport: createFirebaseVaultTransport(uid),
    caseSensitiveNames: caseSensitiveNames(),
  });
  active = { uid, coordinator, generation: started };

  let releaseSnapshot: Unsubscribe | undefined;
  if (hooks?.onSnapshot) {
    releaseSnapshot = coordinator.subscribe(hooks.onSnapshot);
    hooks.onSubscribe?.(releaseSnapshot);
  }

  try {
    await coordinator.start({ awaitRemote: false });
  } catch (error) {
    releaseSnapshot?.();
    if (started === generation) {
      await stopDesktopVaultSync();
    }
    throw error;
  }
  if (started !== generation) {
    releaseSnapshot?.();
    await coordinator.stop();
    return startDesktopVaultSync(uid, hooks);
  }
  return coordinator;
}

export async function stopDesktopVaultSync(): Promise<void> {
  generation += 1;
  const current = active;
  active = null;
  if (!current) {
    return;
  }
  await current.coordinator.stop();
  await window.buddyTunnel.stop();
}

export async function restartDesktopVaultSync(): Promise<VaultSyncCoordinator | null> {
  const uid = active?.uid;
  if (!uid) {
    return null;
  }
  await stopDesktopVaultSync();
  return startDesktopVaultSync(uid);
}

export async function changeDesktopVaultRoot(
  mode: 'choose' | 'default',
  uidHint?: string,
): Promise<VaultSyncCoordinator | null> {
  const uid = active?.uid ?? uidHint;
  if (!uid) {
    throw new Error('Vault sync is not running.');
  }

  if (active) {
    await active.coordinator.stop();
    active = null;
  }

  // Ensure main-process vault is bound to this uid so configure/default work after
  // owner-mismatch or a failed activate that still retained the session uid.
  const status = await window.buddyTunnel.getStatus();
  if (!status.ok || status.value.uid !== uid) {
    const started = await window.buddyTunnel.start(uid);
    if (!started.ok) {
      const again = await window.buddyTunnel.getStatus();
      if (!again.ok || again.value.uid !== uid) {
        throw new Error(started.error.message);
      }
    }
  }

  const result =
    mode === 'choose'
      ? await window.buddyTunnel.configureRoot()
      : await window.buddyTunnel.useDefaultRoot();
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  if (result.value.indexStatus === 'owner-mismatch') {
    throw Object.assign(
      new Error(
        `This vault folder belongs to another account (${result.value.indexOwnerUid ?? 'unknown'}).`,
      ),
      { code: 'owner-mismatch' as const },
    );
  }

  return startDesktopVaultSync(uid);
}
