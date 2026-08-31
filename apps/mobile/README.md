# Buddy Tunnel Mobile

Expo Router mobile client for the Buddy Tunnel file vault.

## Quick start

From the monorepo root:

```bash
pnpm install
cp apps/mobile/.env.example apps/mobile/.env.local
# Fill in EXPO_PUBLIC_FIREBASE_* including EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET
pnpm dev:mobile
```

Sign in with email/password. The **Files** tab lists vault contents; **Settings** configures the vault root when supported.

## Vault behavior

- **Default root:** `Documents/Buddy Tunnel` inside app-controlled storage.
- **Flat list:** Subdirectories and `.buddy-tunnel.json` are ignored.
- **Import:** Document picker, incoming shares (files, text, URLs), and share-sheet targets configured in `app.json`.
- **Open/share:** Native open-in and share-out via system handlers.
- **Sync:** Reconciles on app foreground, screen focus, picker/share completion, and app-owned mutations. There is **no continuous background directory watcher** in v1 — external changes while the app is backgrounded appear after the next foreground rescan.
- **Duplicate names:** Same per-device uniquification as desktop (`Report.2.pdf`, etc.).
- **Inline threshold:** UTF-8 text ≤ 10,000 characters (no NUL) in RTDB; larger text and binaries in Firebase Storage.

## Optional external directory

A system-selected directory is offered only after a write/create/rename/delete probe confirms access survives app restart. Android SAF `content://` URIs may be read-only for some operations; iOS arbitrary writable folder persistence is not assumed. When external selection fails capability checks, the app Documents vault remains the backing store and the picker is import-only.

## Scripts

| Command          | Purpose                        |
| ---------------- | ------------------------------ |
| `pnpm dev`       | Start Expo (from this package) |
| `pnpm typecheck` | TypeScript                     |
| `pnpm lint`      | ESLint                         |

After changing native sharing configuration in `app.json`, rebuild the development client.

## Platform notes

- **Active-only rescans:** Unlike desktop, mobile does not watch the vault directory continuously. Edits made in Files/Finder while the app is backgrounded sync on next foreground.
- **Account switch:** Same UID guard as desktop — mismatched index owner requires a new root or explicit re-association.
- **Permissions:** Revoked storage or share permissions surface errors in the vault UI; retry after restoring access.

See the root [README](../../README.md) for Firebase setup and [`docs/vault-acceptance-matrix.md`](../../docs/vault-acceptance-matrix.md) for manual verification status.
