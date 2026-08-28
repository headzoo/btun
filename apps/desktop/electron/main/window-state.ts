import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type WindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Electron Display.id for the screen the window was on */
  displayId: number;
  isMaximized: boolean;
};

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 700;
const SAVE_DEBOUNCE_MS = 200;
const STATE_FILE = 'window-state.json';

function statePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function isValidState(value: unknown): value is WindowState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.x === 'number' &&
    typeof s.y === 'number' &&
    typeof s.width === 'number' &&
    typeof s.height === 'number' &&
    typeof s.displayId === 'number' &&
    typeof s.isMaximized === 'boolean' &&
    s.width >= 100 &&
    s.height >= 100
  );
}

function boundsIntersect(a: Rectangle, b: Rectangle): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** Ensure saved bounds still land on a connected display; prefer the remembered screen. */
export function resolveWindowBounds(state: WindowState | null): {
  bounds: Rectangle;
  displayId: number;
  isMaximized: boolean;
} {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  if (!state) {
    const { width, height } = primary.workAreaSize;
    return {
      bounds: {
        x: Math.round((width - DEFAULT_WIDTH) / 2) + primary.workArea.x,
        y: Math.round((height - DEFAULT_HEIGHT) / 2) + primary.workArea.y,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
      },
      displayId: primary.id,
      isMaximized: false,
    };
  }

  const preferred =
    displays.find((d) => d.id === state.displayId) ??
    displays.find((d) =>
      boundsIntersect(
        { x: state.x, y: state.y, width: state.width, height: state.height },
        d.bounds,
      ),
    ) ??
    primary;

  const work = preferred.workArea;
  const width = Math.min(state.width, work.width);
  const height = Math.min(state.height, work.height);
  const x = Math.min(Math.max(state.x, work.x), work.x + work.width - width);
  const y = Math.min(Math.max(state.y, work.y), work.y + work.height - height);

  return {
    bounds: { x, y, width, height },
    displayId: preferred.id,
    isMaximized: state.isMaximized,
  };
}

export function loadWindowState(): WindowState | null {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;

  const isMaximized = win.isMaximized();
  // Normal bounds while maximized are still available via getNormalBounds.
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
  const display = screen.getDisplayMatching(bounds);

  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    displayId: display.id,
    isMaximized,
  };

  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[window-state] failed to save', err);
  }
}

/** Persist position/size/display across move, resize, maximize, and close. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveWindowState(win);
    }, SAVE_DEBOUNCE_MS);
  };

  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    saveWindowState(win);
  });
}
