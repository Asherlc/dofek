# Final fix wave — Mountain Project ticks

Date: 2026-09-26  
Base: `185c7637861d2193be74d18b45859f1e6fa19ffd`

## Findings fixed

1. Partial or unsupported Mountain Project exports no longer mark omitted tick IDs absent. Reconciliation runs only when parsing completed without skipped rows. Empty and failed export safety remains covered.
2. Grade progression, volume, session summaries, and activity-entry reads now filter attached ticks with `provider_absent_at IS NULL`. PostgreSQL integration coverage confirms absent rows retain their activity link and raw payload, disappear from active reads, and return after restoration.
3. `ActivityDetail.displayedDate` is computed on the server with `postgresActivityLocalDate`. Suggestions use that same API field, while conditional attachment uses the same SQL helper and timezone rule. Web and mobile render the date-only field in UTC to preserve its calendar day.
4. Attaching a tick invalidates the server `climbing.sessionSummary` cache and web/mobile session-summary query caches.

The web suggestion section was extracted into `UnattachedMountainProjectTicks.tsx` to bring the existing detail page under Biome's per-file limit without changing the route behavior.

## Validation

- RED confirmed before production edits: focused provider cases failed because partial exports tombstoned rows; route/model coverage failed because detail omitted `displayedDate`; PostgreSQL coverage showed absent attached V8 data still winning active climbing reads; cache tests failed because session summaries were not invalidated.
- `pnpm exec vitest run --project unit src/providers/mountain-project.test.ts src/providers/provider-activity-sync-policy.test.ts` — passed, 17/17.
- `pnpm exec vitest run --project unit --project mobile packages/server/src/repositories/mountain-project-tick-repository.test.ts packages/server/src/models/activity.test.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/routers/climbing.test.ts packages/server/src/routers/activity.test.ts packages/web/src/pages/ActivityDetailPage.test.tsx 'packages/mobile/app-tests/activity/[id].test.tsx'` — passed, 251/251 across 7 files.
- `pnpm test:integration -- packages/server/src/repositories/climbing-repository.integration.test.ts packages/server/src/routers/climbing.integration.test.ts src/providers/mountain-project-sync.integration.test.ts` — passed, 10/10 across [climbing repository PostgreSQL integration](../../../packages/server/src/repositories/climbing-repository.integration.test.ts), [climbing router integration](../../../packages/server/src/routers/climbing.integration.test.ts), and [Mountain Project sync integration](../../../src/providers/mountain-project-sync.integration.test.ts).
- `pnpm typecheck` — passed.
- `pnpm lint:sandbox` — passed, including Biome checks and repository policy checks; the previous ActivityDetailPage excessive-lines finding is cleared.
- `git diff --check` — passed.

## Remaining limitation

Production deployment and authenticated production calendar verification are still pending. The previous blocked Docker integration attempt is retained as historical evidence in `docs/production-incident-baseline.md`; the successful workspace PostgreSQL run is recorded alongside it. No production repair or replay was performed.
