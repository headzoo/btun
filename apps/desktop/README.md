# Buddy Tunnel Desktop

Electron + Vite desktop client for the Buddy Tunnel file vault.

## Quick start

From the monorepo root:

```bash
pnpm install
cp apps/desktop/.env.example apps/desktop/.env.local
# Fill in VITE_FIREBASE_* including VITE_FIREBASE_STORAGE_BUCKET
pnpm dev:desktop
```

Sign in with email/password. The **Files** tab lists direct children of the configured vault directory.

## Vault behavior

- **Default root:** `Documents/Buddy Tunnel` (or `~/Buddy Tunnel` if Documents is unavailable). Stored in Electron `userData`, not inside the vault folder.
- **Flat list:** Subdirectories, `.buddy-tunnel.json`, and temp files are ignored.
- **Import:** Drag/drop into the window, paste files from the clipboard (OS-dependent formats), or use import actions in the toolbar.
- **Export:** Drag a row out of the list to copy the file path for external apps.
- **Sync:** Local watcher events debounce into a full scan of direct children; changes reconcile to Firebase immediately while the app is active.
- **Duplicate names:** Remote preferred names may collide locally; the app assigns `stem.2.ext`, `stem.3.ext`, etc. without changing RTDB unless you rename the file in-app.
- **Inline threshold:** UTF-8 text ≤ 10,000 characters (no NUL) stays in RTDB; larger text and all binaries use Firebase Storage.

## Security

Renderer access to the vault is only through `window.buddyTunnel` — a typed, channel-allowlisted preload API. Generic filesystem read/write, `ipcRenderer`, and Node integration are not exposed to the renderer for vault operations.

Run `pnpm test:e2e` to verify startup shell and preload surface (requires a built test bundle).

## Scripts

| Command          | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `pnpm dev`       | Start Electron in development (from this package) |
| `pnpm build`     | Production build                                  |
| `pnpm test`      | Vitest unit tests (vault sync logic)              |
| `pnpm test:e2e`  | Playwright Electron smoke tests                   |
| `pnpm typecheck` | TypeScript                                        |
| `pnpm lint`      | ESLint                                            |

## Platform notes

- **Clipboard paste:** Chromium file paste works everywhere; OS-specific file-list clipboard parsing varies on Windows, macOS, and Linux. Unsupported combinations show a visible error rather than silently failing.
- **Rename detection:** Uses `dev`/`ino` identity when available, with hash/size/mtime fallback; otherwise degrades to delete + create.
- **Account switch:** Sign out stops watchers. An index belonging to another UID is not overwritten — choose a different vault root or re-associate explicitly.

See the root [README](../../README.md) for Firebase rules deployment and the [acceptance matrix](../../docs/vault-acceptance-matrix.md) for manual verification status.
