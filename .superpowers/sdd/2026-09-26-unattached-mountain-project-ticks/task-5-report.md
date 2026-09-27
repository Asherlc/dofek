# Task 5 report: activity detail tick suggestions

## Result

Both activity detail screens now query the Task 3 server suggestion procedure
only for canonical climbing activities and render its returned tick data. The
web and mobile screens each provide an attach control for every suggestion,
per-tick pending and error states, and explicit loading, API error, and empty
states. Attachment invalidates only the current activity's climbing entries
and suggestions. No date matching or climb metric calculation was added to
either client.

Web and mobile route tests cover rendering returned suggestions, attaching only
the selected tick, targeted cache invalidation, and the separate loading, error,
and empty states. Mobile route tests remain in `app-tests`.

## Validation

- `pnpm exec vitest run --project unit packages/web/src/pages/ActivityDetailPage.test.tsx --reporter=dot` — PASS, 67 tests.
- `pnpm exec vitest run --project mobile 'packages/mobile/app-tests/activity/[id].test.tsx' --reporter=dot` — PASS, 30 tests.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check` on the web route test and mobile route plus route test — PASS. `ActivityDetailPage.tsx` still exceeds Biome's 1,000-line rule; the file was already 1,117 lines at the starting commit, before Task 5.
- The requested combined `pnpm test -- ...` selected the known unrelated failure in `src/providers/provider-activity-sync-policy.test.ts`. The two target route suites were rerun independently and passed.

## Retrospective

The tests confirmed the client boundary stayed simple: returned rows are
rendered directly and the API owns displayed-day matching. The main validation
investigation was separating the requested route checks from the unrelated
provider policy failure selected by the root test command. For similar
cross-client API work, retain route-level tests for exact mutation inputs and
cache keys. Suggested documentation improvement: record that this long web
activity detail file already exceeds the Biome line-count threshold, so a
future cleanup can split its existing responsibilities without expanding this
feature's scope. Useful skills next time: `superpowers:test-driven-development`
and `superpowers:verification-before-completion`.
