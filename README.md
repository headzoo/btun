# Buddy Tunnel

Buddy Tunnel is a cross-platform app with an Electron desktop client and an Expo mobile client that share state over Firebase Realtime Database.

This repository is a pnpm TypeScript monorepo. The product UI is still early; both apps currently expose Firebase RTDB connectivity so desktop and mobile can read the same live data.

## Stack

| Piece   | Tech                                                            |
| ------- | --------------------------------------------------------------- |
| Desktop | Electron, Vite, React, Tailwind CSS                             |
| Mobile  | Expo Router, React Native                                       |
| Shared  | `@yard-1/firebase` (Firebase JS SDK + Realtime Database hooks)  |
| Tooling | pnpm workspaces, TypeScript, ESLint, Prettier, Vitest (desktop) |

## Repository layout

```text
yard-1/
├── apps/desktop/         # Electron desktop app (@yard-1/desktop)
├── apps/mobile/          # Expo mobile app (@yard-1/mobile)
├── packages/firebase/    # Shared Firebase init + useRealtimeValue
├── AGENTS.md             # Agent / contributor workflow notes
└── package.json          # Root scripts
```

## Prerequisites

- Node.js matching [`.nvmrc`](.nvmrc) (currently `v24.16.0`) — run `nvm use`
- [pnpm](https://pnpm.io/) `10.17.1` (see `packageManager` in `package.json`)
- A Firebase project with **Realtime Database** enabled

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

Fill in the values from the Firebase console. Desktop uses the `VITE_FIREBASE_*` prefix; mobile uses `EXPO_PUBLIC_FIREBASE_*`. See [`.env.example`](.env.example) for the shared variable names.

Required fields for both apps: API key, auth domain, database URL, and project ID.

## Development

Run each client in its own terminal:

```bash
pnpm dev:desktop   # Electron / Vite
pnpm dev:mobile    # Expo
```

Once configured, both clients subscribe to the Realtime Database `status` path so you can confirm shared live updates.

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

- **`@yard-1/desktop`** — Electron renderer/main app with a Firebase RTDB panel
- **`@yard-1/mobile`** — Expo tabs app with a Firebase RTDB screen
- **`@yard-1/firebase`** — `initFirebase`, `useRealtimeValue`, and shared config types

## License

Private / unpublished workspace (`"private": true`).
