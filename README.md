# Buddy Tunnel

Buddy Tunnel is a cross-platform file vault with an Electron desktop client and an Expo mobile client. Files live in a human-readable folder on each device, stay openable with native apps, and converge across devices through Firebase Realtime Database metadata plus Firebase Storage bytes.

This repository is a pnpm TypeScript monorepo.

## Stack

| Piece   | Tech                                                            |
| ------- | --------------------------------------------------------------- |
| Desktop | Electron, Vite, React, Tailwind CSS                             |
| Mobile  | Expo Router, React Native                                       |
| Shared  | `@yard-1/vault` (sync model), `@yard-1/firebase` (transport)    |
| Tooling | pnpm workspaces, TypeScript, ESLint, Prettier, Vitest (desktop) |

## Repository layout

```text
yard-1/
├── apps/desktop/         # Electron desktop app (@yard-1/desktop)
├── apps/mobile/          # Expo mobile app (@yard-1/mobile)
├── packages/vault/       # Platform-neutral vault sync contracts
├── packages/firebase/    # Firebase init + vault transport
├── database.rules.json   # RTDB security rules (manual deploy)
├── storage.rules         # Firebase Storage rules (manual deploy)
├── docs/                 # Manual acceptance matrix and deployment notes
├── AGENTS.md             # Agent / contributor workflow notes
└── package.json          # Root scripts
```

## Prerequisites

- Node.js matching [`.nvmrc`](.nvmrc) (currently `v24.16.0`) — run `nvm use`
- [pnpm](https://pnpm.io/) `10.17.1` (see `packageManager` in `package.json`)
- A Firebase project with **Realtime Database**, **Firebase Storage**, and **Authentication** enabled

## Setup

```bash
nvm use
pnpm install
```

Configure Firebase for each app you want to run:

```bash
cp apps/desktop/.env.example apps/desktop/.env.local
cp apps/mobile/.env.example apps/mobile/.env.local
```

Fill in values from the Firebase console. Desktop uses the `VITE_FIREBASE_*` prefix; mobile uses `EXPO_PUBLIC_FIREBASE_*`. See [`.env.example`](.env.example) for the shared variable names.

Required fields for both apps:

| Variable                         | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `*_FIREBASE_API_KEY`             | Web API key                                                             |
| `*_FIREBASE_AUTH_DOMAIN`         | Auth domain                                                             |
| `*_FIREBASE_DATABASE_URL`        | Realtime Database URL                                                   |
| `*_FIREBASE_PROJECT_ID`          | Project ID                                                              |
| `*_FIREBASE_STORAGE_BUCKET`      | Storage bucket (`project-id.appspot.com`) — **required for blob files** |
| `*_FIREBASE_MESSAGING_SENDER_ID` | Messaging sender ID                                                     |
| `*_FIREBASE_APP_ID`              | App ID                                                                  |

Blob uploads and downloads fail at runtime when `storageBucket` is missing. Inline UTF-8 text (≤ 10,000 characters, no NUL) still syncs through RTDB alone, but any binary or larger text needs Storage configured.

### Firebase Authentication

Both apps require a signed-in user (email/password). Before first launch:

1. In the [Firebase Console](https://console.firebase.google.com/), open **Authentication** → **Sign-in method** and enable **Email/Password**.
2. Create a test account with the in-app **Create account** flow, or add a user under **Authentication** → **Users**.

Unauthenticated users are sent to the sign-in screen.

### Vault data model (v1)

Stable file IDs are RTDB push IDs under `storage/{uid}/{id}`. Each v1 record contains:

| Field                                    | Notes                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `schemaVersion`                          | Always `1` for new records                                                       |
| `name`                                   | Preferred name (may duplicate across devices)                                    |
| `createdAt`                              | Immutable milliseconds since epoch                                               |
| `updatedAt`                              | Server timestamp on commit                                                       |
| `size`, `mimeType`, `sha256`, `revision` | Content metadata                                                                 |
| `content`                                | `{ kind: "inline", text, encoding: "utf-8" }` or `{ kind: "blob", storagePath }` |

Inline eligibility: valid UTF-8 text with no NUL byte and at most **10,000 JavaScript characters** (text is never trimmed). Everything else is stored at immutable Storage paths:

```text
vault/{uid}/{id}/{revision}
```

Deletions remove the live RTDB record and write a tombstone under `storageTombstones/{uid}/{id}` with `deletedAt` and `revision`. Tombstones participate in last-write-wins and prevent stale offline work from resurrecting deleted IDs.

Each device keeps a hidden `.buddy-tunnel.json` index in the vault root with ID-to-local-name mappings, applied remote state, optional file identity, and a pending-operation journal. The UI lists direct child files only; subdirectories and the index are ignored.

Legacy `{createdAt, message}` records are migrated in place to v1 inline text on first sync. See `@yard-1/vault` for parsers and `@yard-1/firebase` for the transport.

Default vault roots:

- **Desktop:** `Documents/Buddy Tunnel` (falls back to `~/Buddy Tunnel`)
- **Mobile:** app Documents `Buddy Tunnel` (optional system-selected directory when write access survives restart)

Local duplicate preferred names are uniquified per device (`Report.pdf`, `Report.2.pdf`, …). Suffixes are never written back to RTDB unless the user explicitly renames that ID.

### Firebase rules deployment (maintainer-owned)

Rules are versioned in [`database.rules.json`](database.rules.json) and [`storage.rules`](storage.rules). Publish with:

```bash
pnpm firebase:provision:database   # once, if RTDB is not created yet
pnpm firebase:provision:storage     # once, if Storage is not set up (requires Blaze plan)
pnpm firebase:deploy:rules
```

Requires the [Firebase CLI](https://firebase.google.com/docs/cli) (`firebase-tools`, installed at the repo root) and `firebase login`. The default project is set in [`.firebaserc`](.firebaserc) (`buddy-tunnel`). Override with `firebase use <project-id>`.

Hosting for the app homepage uses the [`public/`](public/) directory. Deploy with:

```bash
pnpm firebase:deploy:hosting
```

Manual Console publish remains valid for rules if you prefer.

Safe rollout sequence:

1. Ship clients that read v1 records, migrate legacy text, and tolerate tombstones.
2. Publish **Storage** rules from `storage.rules` (Firebase Console → **Storage** → **Rules**).
3. Publish **RTDB** rules from `database.rules.json` (Firebase Console → **Realtime Database** → **Rules**).
4. Verify legacy `{createdAt, message}` records migrate to v1 on first connect.
5. Confirm cross-user reads/writes are denied and blob paths are owner-scoped.

Manual verification cases (Rules Playground or two test accounts):

| Case                                                     | Expected |
| -------------------------------------------------------- | -------- |
| Owner read/write own `storage/{uid}`                     | Allow    |
| Cross-user read/write                                    | Deny     |
| New legacy `{createdAt, message}` create                 | Deny     |
| Owner delete + tombstone write                           | Allow    |
| Inline text > 10,000 chars                               | Deny     |
| Blob path outside `vault/{uid}/{id}/{revision}`          | Deny     |
| Storage object under another user's `vault/{otherUid}/…` | Deny     |

Platform limits documented in app READMEs and [`docs/vault-acceptance-matrix.md`](docs/vault-acceptance-matrix.md).

## Development

Run each client in its own terminal:

```bash
pnpm dev:desktop   # Electron / Vite
pnpm dev:mobile    # Expo
```

## Scripts

| Command                             | Purpose                                |
| ----------------------------------- | -------------------------------------- |
| `pnpm dev:desktop`                  | Start the Electron desktop app         |
| `pnpm dev:mobile`                   | Start the Expo mobile app              |
| `pnpm lint`                         | ESLint across workspace packages       |
| `pnpm typecheck`                    | TypeScript checks                      |
| `pnpm format` / `pnpm format:check` | Prettier write / check                 |
| `pnpm test`                         | Full test suite                        |
| `pnpm test:changed`                 | Tests affected by git changes          |
| `pnpm check`                        | lint + format:check + typecheck + test |

Scoped examples:

```bash
pnpm --filter @yard-1/desktop lint
pnpm --filter @yard-1/desktop typecheck
pnpm --filter @yard-1/desktop test
```

Use **pnpm only** — do not use npm or yarn.

## Packages

- **`@yard-1/desktop`** — Electron vault UI with context-isolated preload API
- **`@yard-1/mobile`** — Expo vault browser with share/import and foreground rescan
- **`@yard-1/vault`** — Shared sync model, reconciliation, names, and index schema
- **`@yard-1/firebase`** — `initFirebase`, auth hooks, and `createFirebaseVaultTransport`

## License

Private / unpublished workspace (`"private": true`).
