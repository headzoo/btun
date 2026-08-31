export type VaultRescanReason =
  'app-active' | 'focus' | 'import' | 'share' | 'picker' | 'root-change' | 'refresh' | 'mutation';

type RescanListener = (reason: VaultRescanReason) => void;

const rescanListeners = new Set<RescanListener>();

/** Notify active vault consumers that a rescan should run (picker/share/mutation). */
export function requestVaultRescan(reason: VaultRescanReason): void {
  for (const listener of rescanListeners) {
    try {
      listener(reason);
    } catch {
      // ignore listener failures
    }
  }
}

export function subscribeVaultRescanRequests(listener: RescanListener): () => void {
  rescanListeners.add(listener);
  return () => {
    rescanListeners.delete(listener);
  };
}
