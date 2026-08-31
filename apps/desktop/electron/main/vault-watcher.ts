import fs from 'node:fs';
import type { LocalVaultEvent } from '@yard-1/vault';

export interface VaultWatcher {
  close(): void;
}

/**
 * Non-recursive directory watch used only as an invalidation trigger.
 * Callers debounce and perform a full direct-child rescan.
 */
export function watchVaultRoot(root: string, onInvalidate: () => void): VaultWatcher {
  let closed = false;
  let watcher: fs.FSWatcher | null = null;

  try {
    watcher = fs.watch(root, { persistent: true }, () => {
      if (!closed) {
        onInvalidate();
      }
    });
    watcher.on('error', () => {
      if (!closed) {
        onInvalidate();
      }
    });
  } catch {
    // Some platforms can fail watch setup; callers still scan on demand.
  }

  return {
    close() {
      closed = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

export function createDebouncedInvalidation(
  delayMs: number,
  run: () => void | Promise<void>,
): { trigger: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let queued = false;

  const flush = async () => {
    timer = null;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        await run();
      } while (queued);
    } finally {
      running = false;
    }
  };

  return {
    trigger() {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void flush();
      }, delayMs);
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queued = false;
    },
  };
}

export type LocalEventListener = (event: LocalVaultEvent) => void;
