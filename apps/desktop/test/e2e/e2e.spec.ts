import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  type ElectronApplication,
  type Page,
  type JSHandle,
  expect,
  test,
  _electron as electron,
} from '@playwright/test';
import type { BrowserWindow } from 'electron';

const root = path.resolve(import.meta.dirname, '..', '..');
let electronApp: ElectronApplication;
let page: Page;
let xvfbProcess: ChildProcess | undefined;

function startXvfbOnLinux(): Promise<void> {
  if (process.platform !== 'linux' || process.env.DISPLAY) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1280x720x24', '-ac'], {
      stdio: 'ignore',
      detached: true,
    });

    xvfbProcess.once('error', reject);

    setTimeout(() => {
      process.env.DISPLAY = ':99';
      resolve();
    }, 500);
  });
}

test.beforeAll(async () => {
  test.setTimeout(30000);
  await startXvfbOnLinux();

  electronApp = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development' },
  });
  page = await electronApp.firstWindow();

  const mainWin: JSHandle<BrowserWindow> = await electronApp.browserWindow(page);
  await mainWin.evaluate(async (win) => {
    win.webContents.executeJavaScript('console.log("Execute JavaScript with e2e testing.")');
  });
});

test.afterAll(async () => {
  if (page) {
    await page.screenshot({ path: 'test/screenshots/e2e.png' });
    await page.close();
  }

  if (electronApp) {
    await electronApp.close();
  }

  if (xvfbProcess?.pid) {
    process.kill(-xvfbProcess.pid);
    xvfbProcess = undefined;
  }
});

test.describe('[buddy-tunnel] desktop shell', () => {
  test('startup title', async () => {
    const title = await page.title();
    expect(title).toBe('Buddy Tunnel');
  });

  test('shows auth or configuration-safe vault shell', async () => {
    await page.waitForSelector('h1', { timeout: 15000 });
    const h1 = await page.$('h1');
    const title = (await h1?.textContent())?.trim() ?? '';
    expect([
      'Sign in',
      'Create account',
      'Firebase is not configured',
      'Buddy Tunnel',
      'Files',
    ]).toContain(title);
  });

  test('preload exposes narrow buddyTunnel API without filesystem primitives', async () => {
    const bridge = await page.evaluate(() => {
      const api = (window as unknown as { buddyTunnel?: Record<string, unknown> }).buddyTunnel;
      if (!api || typeof api !== 'object') {
        return { present: false as const };
      }
      return {
        present: true as const,
        keys: Object.keys(api).sort(),
        hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
        hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
        hasFs: typeof (window as unknown as { fs?: unknown }).fs !== 'undefined',
      };
    });

    expect(bridge.present).toBe(true);
    if (!bridge.present) {
      return;
    }
    expect(bridge.hasRequire).toBe(false);
    expect(bridge.hasProcess).toBe(false);
    expect(bridge.hasFs).toBe(false);
    expect(bridge.keys).toEqual(
      expect.arrayContaining([
        'start',
        'stop',
        'list',
        'importDroppedFiles',
        'importClipboard',
        'open',
        'reveal',
        'startDrag',
        'configureRoot',
      ]),
    );
    expect(bridge.keys).not.toContain('importPaths');
    expect(bridge.keys).not.toEqual(expect.arrayContaining(['readFile', 'writeFile', 'readdir']));
  });
});
