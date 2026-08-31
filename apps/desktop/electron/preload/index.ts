import { ipcRenderer, contextBridge, webUtils } from 'electron';
import type {
  BuddyTunnelApi,
  ImportedFileResult,
  MaterializeInput,
  RenameInput,
} from '../main/vault-api';
import { BUDDY_TUNNEL_CHANNELS } from '../main/vault-api';
import type { ExpectedLocalEffect, LocalVaultEvent, VaultIndex, VaultResult } from '@yard-1/vault';

const UPDATER_INVOKE_CHANNELS = new Set([
  'check-update',
  'start-download',
  'cancel-download',
  'quit-and-install',
  'open-win',
]);

const UPDATER_LISTEN_CHANNELS = new Set([
  'main-process-message',
  'update-can-available',
  'update-error',
  'download-progress',
  'update-downloaded',
]);

function pathsFromDroppedFiles(files: File[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        paths.push(filePath);
      }
    } catch {
      // Skip files without a resolvable path (e.g. browser-only blobs).
    }
  }
  return paths;
}

const buddyTunnel: BuddyTunnelApi = {
  start(uid) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.start, uid);
  },
  stop() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.stop);
  },
  getStatus() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.getStatus);
  },
  list() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.list);
  },
  listDirectChildren() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.listChildren);
  },
  loadIndex() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.loadIndex);
  },
  saveIndex(index: VaultIndex) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.saveIndex, index);
  },
  configureRoot() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.configureRoot);
  },
  useDefaultRoot() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.useDefaultRoot);
  },
  importDroppedFiles(files) {
    return ipcRenderer.invoke(
      BUDDY_TUNNEL_CHANNELS.importDroppedFiles,
      pathsFromDroppedFiles(files),
    ) as Promise<VaultResult<ImportedFileResult[]>>;
  },
  importClipboard() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.importClipboard);
  },
  readBytes(localName) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.readBytes, localName);
  },
  materialize(input: MaterializeInput) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.materialize, input);
  },
  writeAtomic(localName, bytes) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.writeAtomic, localName, bytes);
  },
  rename(input: RenameInput) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.rename, input);
  },
  remove(localName) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.remove, localName);
  },
  open(localName) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.open, localName);
  },
  reveal(localName) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.reveal, localName);
  },
  revealRoot() {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.revealRoot);
  },
  startDrag(localName) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.startDrag, localName);
  },
  registerExpectedEffect(effect: ExpectedLocalEffect) {
    return ipcRenderer.invoke(BUDDY_TUNNEL_CHANNELS.registerExpectedEffect, effect);
  },
  onLocalChange(listener: (event: LocalVaultEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, payload: LocalVaultEvent) => {
      listener(payload);
    };
    ipcRenderer.on(BUDDY_TUNNEL_CHANNELS.localEvent, handler);
    return () => {
      ipcRenderer.off(BUDDY_TUNNEL_CHANNELS.localEvent, handler);
    };
  },
};

contextBridge.exposeInMainWorld('buddyTunnel', buddyTunnel);

// Keep updater/demo IPC available, but only on an allowlisted channel set.
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(channel: string, listener: (...args: unknown[]) => void) {
    if (!UPDATER_LISTEN_CHANNELS.has(channel)) {
      throw new Error(`Blocked ipcRenderer.on channel: ${channel}`);
    }
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args));
  },
  off(channel: string, listener: (...args: unknown[]) => void) {
    if (!UPDATER_LISTEN_CHANNELS.has(channel)) {
      throw new Error(`Blocked ipcRenderer.off channel: ${channel}`);
    }
    return ipcRenderer.off(channel, listener as never);
  },
  send(channel: string, ...omit: unknown[]) {
    if (!UPDATER_LISTEN_CHANNELS.has(channel) && !UPDATER_INVOKE_CHANNELS.has(channel)) {
      throw new Error(`Blocked ipcRenderer.send channel: ${channel}`);
    }
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(channel: string, ...omit: unknown[]) {
    if (!UPDATER_INVOKE_CHANNELS.has(channel)) {
      throw new Error(`Blocked ipcRenderer.invoke channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...omit);
  },
});

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise((resolve) => {
    if (condition.includes(document.readyState)) {
      resolve(true);
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true);
        }
      });
    }
  });
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find((e) => e === child)) {
      return parent.appendChild(child);
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find((e) => e === child)) {
      return parent.removeChild(child);
    }
  },
};

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`;
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `;
  const oStyle = document.createElement('style');
  const oDiv = document.createElement('div');

  oStyle.id = 'app-loading-style';
  oStyle.innerHTML = styleContent;
  oDiv.className = 'app-loading-wrap';
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`;

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle);
      safeDOM.append(document.body, oDiv);
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle);
      safeDOM.remove(document.body, oDiv);
    },
  };
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading();
domReady().then(appendLoading);

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading();
};

setTimeout(removeLoading, 4999);
