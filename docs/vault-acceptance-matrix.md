# Vault manual acceptance matrix

Recorded during BP-007. Automated Vitest coverage lives in `apps/desktop/test/vault-*.test.ts`. Native/OS behavior below requires manual exercise; **NOT_RUN** means this environment did not execute that check — do not treat it as passed.

Environment for this record: Linux desktop dev host, no paired iOS/Android devices in CI.

## Cross-platform sync (two authenticated clients)

| Scenario                               | Desktop Linux | Desktop macOS | Desktop Windows | iOS     | Android |
| -------------------------------------- | ------------- | ------------- | --------------- | ------- | ------- |
| Inline text create propagates          | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Binary/blob create propagates          | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Simultaneous edit (last-write-wins)    | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Rename propagation                     | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Delete + tombstone propagation         | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Offline queued edit vs newer remote    | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Offline edit vs remote delete          | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Restart with pending journal           | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Account switch / UID mismatch guard    | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |
| Root change rematerializes cloud state | NOT_RUN       | NOT_RUN       | NOT_RUN         | NOT_RUN | NOT_RUN |

Deterministic two-client convergence for create/edit/rename/delete/tombstone/offline/restart is covered by `vault-coordinator.test.ts` with in-memory adapters (PASS in CI).

## Desktop-native

| Scenario                            | Linux   | macOS   | Windows |
| ----------------------------------- | ------- | ------- | ------- |
| Finder/Explorer local edit detected | NOT_RUN | NOT_RUN | NOT_RUN |
| Subdirectory ignored                | NOT_RUN | NOT_RUN | NOT_RUN |
| Duplicate preferred names on disk   | NOT_RUN | NOT_RUN | NOT_RUN |
| Drag files into app                 | NOT_RUN | NOT_RUN | NOT_RUN |
| Drag row out of app                 | NOT_RUN | NOT_RUN | NOT_RUN |
| Clipboard file paste                | NOT_RUN | NOT_RUN | NOT_RUN |
| Native open / reveal                | NOT_RUN | NOT_RUN | NOT_RUN |
| Symlink / special file ignored      | NOT_RUN | NOT_RUN | NOT_RUN |

Preload security and vault shell startup: `apps/desktop/test/e2e/e2e.spec.ts` (PASS when e2e suite runs).

## Mobile-native

| Scenario                                 | iOS     | Android |
| ---------------------------------------- | ------- | ------- |
| Share single file into app               | NOT_RUN | NOT_RUN |
| Share multiple files                     | NOT_RUN | NOT_RUN |
| Share short text                         | NOT_RUN | NOT_RUN |
| Share text > 10,000 characters (blob)    | NOT_RUN | NOT_RUN |
| Document picker import                   | NOT_RUN | NOT_RUN |
| Open-in / share-out                      | NOT_RUN | NOT_RUN |
| Foreground rescan after external edit    | NOT_RUN | NOT_RUN |
| Share while signed out (queued/rejected) | NOT_RUN | NOT_RUN |
| External writable root capability probe  | NOT_RUN | NOT_RUN |
| Permission revocation handling           | NOT_RUN | NOT_RUN |

## Firebase rules (maintainer)

| Scenario                                     | Status  |
| -------------------------------------------- | ------- |
| RTDB rules published to production           | NOT_RUN |
| Storage rules published to production        | NOT_RUN |
| Legacy record migration on real project      | NOT_RUN |
| Cross-user deny verified in Rules Playground | NOT_RUN |

Rules files are versioned in-repo (`database.rules.json`, `storage.rules`). Deployment remains a maintainer manual step — see root [README](../README.md).

## Automated invariant coverage (CI)

| Area                                             | Test file                   | CI   |
| ------------------------------------------------ | --------------------------- | ---- |
| Name validation / uniquification                 | `vault-names.test.ts`       | PASS |
| Index load / corrupt / owner / tombstones        | `vault-index.test.ts`       | PASS |
| Reconciliation decisions                         | `vault-reconcile.test.ts`   | PASS |
| Journal restart / supersede                      | `vault-journal.test.ts`     | PASS |
| Coordinator echo / races / inline↔blob / restart | `vault-coordinator.test.ts` | PASS |
| Record parse / legacy migration / clocks         | `vault-records.test.ts`     | PASS |
| Desktop adapter boundaries                       | `vault-desktop.test.ts`     | PASS |
