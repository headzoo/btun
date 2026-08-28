## Development servers

Keep `pnpm dev:desktop` or `pnpm dev:mobile` in a dedicated terminal. Agents must not
Ctrl+C those processes or reuse their terminals for `pnpm test`, `pnpm check`, or
other commands.

```bash
pnpm dev:desktop   # Electron / Vite desktop app
pnpm dev:mobile    # Expo mobile app
```

## Linting

Prefer scoped checks while iterating so concurrent agents do not all hammer the full monorepo suite. Filter to the packages you changed:

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test:changed
```

Common filters: `@yard-1/desktop`, `@yard-1/mobile`, `@yard-1/firebase`. Skip
`format:check` on a filter when that package has no such script (use root
`pnpm format:check` only if you need a full format pass).

Example scoped usage:

```bash
pnpm --filter @yard-1/desktop lint
pnpm --filter @yard-1/desktop typecheck
pnpm --filter @yard-1/desktop test:changed
```

After every code change, run the four commands above (scoped when possible).
Before finishing a task, run the full suite once from the repo root:

```bash
pnpm check
```

Fix any reported issues before finishing the task.

## Testing

Always run tests via the pnpm scripts below — never `vitest` or
`pnpm exec vitest run` directly.

Unit tests live in `apps/desktop/test/**/*.test.ts` (Vitest). Mobile and
shared packages may gain tests later; root scripts use `--if-present` so
packages without a test script are skipped.

```bash
pnpm test:changed         # fast iteration — tests affected by git changes
pnpm test                 # full suite (also covered by pnpm check)
pnpm --filter @yard-1/desktop test
```

## Package manager

Use `pnpm` only. Lockfile is `pnpm-lock.yaml`. Do not use npm or yarn.

## Dependencies and scope

- Do not add new dependencies without maintainer approval.
- Avoid large refactors unless explicitly requested.
