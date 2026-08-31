import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import type { ExpectedLocalEffect, VaultIndex, VaultResult } from '@yard-1/vault';
import { fail, forwardFail, ok } from './vault-paths';
import { readClipboardFilePaths } from './vault-clipboard';
import { VaultService, type VaultServiceHost } from './vault-service';
import {
  BUDDY_TUNNEL_CHANNELS,
  BUDDY_TUNNEL_INVOKE_CHANNELS,
  type ImportedFileResult,
  type MaterializeInput,
  type RenameInput,
  type VaultStatus,
} from './vault-api';

function isAllowedSender(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | null,
): boolean {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return false;
  }
  return event.sender.id === win.webContents.id;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function createHost(
  getMainWindow: () => BrowserWindow | null,
  paths: {
    userDataPath: string;
    documentsPath: string;
    homePath: string;
  },
): VaultServiceHost {
  return {
    userDataPath: paths.userDataPath,
    documentsPath: paths.documentsPath,
    homePath: paths.homePath,
    async showOpenDirectoryDialog() {
      const win = getMainWindow();
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
          });
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0] ?? null;
    },
    openPath(target: string) {
      return shell.openPath(target);
    },
    showItemInFolder(target: string) {
      shell.showItemInFolder(target);
    },
    startDrag(payload) {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) {
        throw new Error('No active window for drag.');
      }
      win.webContents.startDrag({
        file: payload.file,
        icon: payload.icon ?? nativeImageEmpty(),
      });
    },
  };
}

function nativeImageEmpty(): Electron.NativeImage {
  return nativeImage.createEmpty();
}

export function createVaultIpc(options: {
  getMainWindow: () => BrowserWindow | null;
  userDataPath: string;
  documentsPath: string;
  homePath: string;
}): { service: VaultService; dispose: () => void } {
  const service = new VaultService(
    createHost(options.getMainWindow, {
      userDataPath: options.userDataPath,
      documentsPath: options.documentsPath,
      homePath: options.homePath,
    }),
  );

  const guard = async <T>(
    event: IpcMainInvokeEvent,
    run: () => Promise<VaultResult<T>> | VaultResult<T>,
  ): Promise<VaultResult<T>> => {
    if (!isAllowedSender(event, options.getMainWindow)) {
      return fail('permission', 'Vault IPC caller is not the main window.');
    }
    return run();
  };

  const handlers: Array<
    [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>]
  > = [
    [
      BUDDY_TUNNEL_CHANNELS.start,
      async (event, uid) =>
        guard(event, async () => {
          const value = asString(uid);
          if (!value) {
            return fail('unsafe-name', 'uid must be a string.');
          }
          return service.start(value);
        }),
    ],
    [BUDDY_TUNNEL_CHANNELS.stop, async (event) => guard(event, () => service.stop())],
    [
      BUDDY_TUNNEL_CHANNELS.getStatus,
      async (event) => guard(event, async () => ok(service.getStatus())),
    ],
    [BUDDY_TUNNEL_CHANNELS.list, async (event) => guard(event, () => service.listEntries())],
    [
      BUDDY_TUNNEL_CHANNELS.listChildren,
      async (event) =>
        guard(event, async () => {
          const children = await service.listDirectChildren();
          return ok(children);
        }),
    ],
    [BUDDY_TUNNEL_CHANNELS.loadIndex, async (event) => guard(event, () => service.loadIndex())],
    [
      BUDDY_TUNNEL_CHANNELS.saveIndex,
      async (event, index) =>
        guard(event, async () => {
          if (!index || typeof index !== 'object') {
            return fail('unsafe-name', 'saveIndex requires a vault index object.');
          }
          return service.saveIndex(index as VaultIndex);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.configureRoot,
      async (event) => guard(event, () => service.configureRoot()),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.useDefaultRoot,
      async (event) => guard(event, () => service.useDefaultRoot()),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.importDroppedFiles,
      async (event, paths) =>
        guard(event, async () => {
          const value = asStringArray(paths);
          if (!value) {
            return fail('unsafe-name', 'paths must be a string array.');
          }
          return service.importPaths(value);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.importClipboard,
      async (event) =>
        guard(event, async (): Promise<VaultResult<ImportedFileResult[]>> => {
          const paths = readClipboardFilePaths();
          if (!paths.ok) {
            return forwardFail(paths);
          }
          return service.importPaths(paths.value);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.readBytes,
      async (event, localName) =>
        guard(event, async () => {
          const value = asString(localName);
          if (!value) {
            return fail('unsafe-name', 'localName must be a string.');
          }
          return service.readBytesResult(value);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.materialize,
      async (event, input) =>
        guard(event, async () => {
          if (!input || typeof input !== 'object') {
            return fail('unsafe-name', 'materialize input is invalid.');
          }
          const payload = input as MaterializeInput;
          const localName = asString(payload.localName);
          const bytes = asBytes(payload.bytes);
          if (!localName || !bytes) {
            return fail('unsafe-name', 'materialize requires localName and bytes.');
          }
          return service.materialize(localName, bytes);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.writeAtomic,
      async (event, localName, bytesValue) =>
        guard(event, async () => {
          const name = asString(localName);
          const bytes = asBytes(bytesValue);
          if (!name || !bytes) {
            return fail('unsafe-name', 'writeAtomic requires localName and bytes.');
          }
          return service.writeAtomicResult(name, bytes);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.rename,
      async (event, input) =>
        guard(event, async () => {
          if (!input || typeof input !== 'object') {
            return fail('unsafe-name', 'rename input is invalid.');
          }
          const payload = input as RenameInput;
          const from = asString(payload.from);
          const to = asString(payload.to);
          if (!from || !to) {
            return fail('unsafe-name', 'rename requires from and to.');
          }
          return service.renameResult(from, to);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.remove,
      async (event, localName) =>
        guard(event, async () => {
          const value = asString(localName);
          if (!value) {
            return fail('unsafe-name', 'localName must be a string.');
          }
          return service.removeResult(value);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.open,
      async (event, localName) =>
        guard(event, async () => {
          const value = asString(localName);
          if (!value) {
            return fail('unsafe-name', 'localName must be a string.');
          }
          return service.openLocal(value);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.reveal,
      async (event, localName) =>
        guard(event, async () => {
          const value = asString(localName);
          if (!value) {
            return fail('unsafe-name', 'localName must be a string.');
          }
          return service.revealLocal(value);
        }),
    ],
    [BUDDY_TUNNEL_CHANNELS.revealRoot, async (event) => guard(event, () => service.revealRoot())],
    [
      BUDDY_TUNNEL_CHANNELS.startDrag,
      async (event, localName) =>
        guard(event, async () => {
          const value = asString(localName);
          if (!value) {
            return fail('unsafe-name', 'localName must be a string.');
          }
          return service.startDrag(value);
        }),
    ],
    [
      BUDDY_TUNNEL_CHANNELS.registerExpectedEffect,
      async (event, effect) =>
        guard(event, async () => {
          if (!effect || typeof effect !== 'object') {
            return fail('unsafe-name', 'expected effect is invalid.');
          }
          return service.registerExpectedEffectResult(effect as ExpectedLocalEffect);
        }),
    ],
  ];

  for (const [channel, handler] of handlers) {
    if (!BUDDY_TUNNEL_INVOKE_CHANNELS.includes(channel)) {
      continue;
    }
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
  }

  const unsubscribe = service.subscribeLocalChanges((vaultEvent) => {
    const win = options.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send(BUDDY_TUNNEL_CHANNELS.localEvent, vaultEvent);
  });

  return {
    service,
    dispose() {
      unsubscribe();
      for (const channel of BUDDY_TUNNEL_INVOKE_CHANNELS) {
        ipcMain.removeHandler(channel);
      }
      void service.stop();
    },
  };
}

export type { ImportedFileResult, VaultStatus };
