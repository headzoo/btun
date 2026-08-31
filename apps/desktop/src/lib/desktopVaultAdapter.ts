import type {
  DirectChildSnapshot,
  ExpectedLocalEffect,
  LocalVaultEvent,
  Unsubscribe,
  VaultAdapter,
  VaultIndex,
  VaultIndexLoadResult,
  VaultIndexStore,
  VaultResult,
} from '@yard-1/vault';

function unwrap<T>(result: VaultResult<T>, fallback: string): T {
  if (!result.ok) {
    throw new Error(result.error.message || fallback);
  }
  return result.value;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  throw new Error('Expected file bytes from the vault adapter.');
}

export function createDesktopVaultAdapter(): VaultAdapter & VaultIndexStore {
  const api = window.buddyTunnel;
  return {
    async listDirectChildren(): Promise<DirectChildSnapshot[]> {
      return unwrap(await api.listDirectChildren(), 'Failed to list vault files.');
    },
    async readBytes(name: string): Promise<Uint8Array> {
      return asBytes(unwrap(await api.readBytes(name), `Failed to read ${name}.`));
    },
    async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
      unwrap(await api.writeAtomic(name, bytes), `Failed to write ${name}.`);
    },
    async rename(from: string, to: string): Promise<void> {
      unwrap(await api.rename({ from, to }), `Failed to rename ${from}.`);
    },
    async remove(name: string): Promise<void> {
      unwrap(await api.remove(name), `Failed to delete ${name}.`);
    },
    async registerExpectedEffect(effect: ExpectedLocalEffect): Promise<void> {
      unwrap(await api.registerExpectedEffect(effect), 'Failed to register expected vault effect.');
    },
    subscribeLocalChanges(listener: (event: LocalVaultEvent) => void): Unsubscribe {
      return api.onLocalChange(listener);
    },
    async loadIndex(): Promise<VaultIndexLoadResult> {
      return unwrap(await api.loadIndex(), 'Failed to load vault index.');
    },
    async saveIndex(index: VaultIndex): Promise<void> {
      unwrap(await api.saveIndex(index), 'Failed to save vault index.');
    },
  };
}
