# Task 3 implementation report

Status: implementation complete; committed and pushed after focused validation.

## Changes

- `ActivityDetail.durationMin` is now server-projected from the measured start/end timestamps, rounded to one decimal place like the calendar value, and null when the end is unknown.
- Web and mobile detail headers display the projected duration and each Kilter source-session window. Shared local-time range formatting reuses `formatRecordLocalTime`; provider labels and view markup remain platform-local.
- Cards render “Duration unavailable” for a null duration. Mobile climbing cards omit unavailable distance text when the effective displayed activity type is climbing while retaining measured distances and other types' existing behavior.
- Connected and standalone Kilter fixtures now have accurate Kilter provenance and climbing measurements. The connected fixture shows a 55-minute measured session and 138/168 bpm, with cycling/distance/elevation/speed/cadence facts unavailable. Unknown-duration cards have Kilter attribution and no training-stress stat.
- Updated `docs/climbing-providers.md` and `docs/production-incident-baseline.md`. The baseline now includes the lead-authored local validation incident and marks production recovery unverified rather than design-paused.

## Changed files

- `.superpowers/sdd/2026-11-09-kilter-log-sessions/task-3-report.md`
- `docs/climbing-providers.md`
- `docs/production-incident-baseline.md`
- `packages/format/src/record-local-time.ts`
- `packages/format/src/record-local-time.test.ts`
- `packages/server/src/models/activity.ts`
- `packages/server/src/models/activity.test.ts`
- `packages/server/src/repositories/activities-calendar-repository.ts`
- `packages/server/src/repositories/activities-calendar-repository.integration.test.ts`
- `packages/web/src/components/ActivityCardContent.tsx`
- `packages/web/src/components/ActivityCardContent.test.tsx`
- `packages/web/src/components/ActivityCardContent.stories.tsx`
- `packages/web/src/pages/ActivityDetailPage.tsx`
- `packages/web/src/pages/ActivityDetailPage.test.tsx`
- `packages/web/src/pages/ActivityDetailPage.stories.tsx`
- `packages/mobile/app/activity/[id].tsx`
- `packages/mobile/app-tests/activity/[id].test.tsx`
- `packages/mobile/components/ActivityCard.tsx`
- `packages/mobile/components/ActivityCard.test.tsx`
- `packages/mobile/components/ActivityCard.stories.tsx`
- `packages/mobile/components/activity/ActivityDetailHeader.tsx`
- `packages/mobile/components/activity/ActivityDetailHeader.test.tsx`
- `packages/mobile/components/activity/ActivityDetailHeader.stories.tsx`
- `packages/mobile/components/activity/ActivityDetailHeader.fixtures.ts`

## RED/GREEN evidence

- **Server duration DTO:** `rtk pnpm exec vitest run packages/server/src/models/activity.test.ts` first failed 1/20 because `durationMin` was not projected (`/tmp/kilter-task3-activity-model-red.log`). After asserting the shared one-decimal convention, the same command failed with expected `90.5`, received `91` (`/tmp/kilter-task3-activity-rounding-red.log`). Final result: 20/20 pass (`/tmp/kilter-task3-server-final2.log`). The test also verifies a null end remains null.
- **Shared record-time range:** `rtk pnpm exec vitest run packages/format/src/record-local-time.test.ts` failed the two new range/single-instant cases because the function did not exist (54 passed, 2 failed; `/tmp/kilter-task3-time-range-red.log`). Final result: 56/56 pass (`/tmp/kilter-task3-format-final2.log`), including DST-crossing range and same-instant coverage.
- **Visible unknown duration:** After updating tests first to require visible status text, the web command `rtk pnpm exec vitest run packages/web/src/components/ActivityCardContent.test.tsx packages/web/src/pages/ActivityDetailPage.test.tsx` failed 3 assertions for missing “Duration unavailable” / “Unavailable” text (`/tmp/kilter-task3-visible-state-web-red.log`). The mobile command `rtk pnpm exec vitest run packages/mobile/components/ActivityCard.test.tsx 'packages/mobile/app-tests/activity/[id].test.tsx'` failed 2 assertions for the same missing visible text (`/tmp/kilter-task3-visible-state-mobile-red.log`). Final web result: 144/144 pass (`/tmp/kilter-task3-web-final2.log`). Final mobile result: 113/113 pass across three focused files (`/tmp/kilter-task3-mobile-final4.log`).
- **Climbing card distance parity:** `rtk pnpm exec vitest run packages/mobile/components/ActivityCard.test.tsx` failed the new absent-distance climbing case (20 passed, 1 failed; `/tmp/kilter-task3-mobile-climbing-distance-red.log`). Final result: 21/21 pass, including absent and measured climbing distance (`/tmp/kilter-task3-mobile-climbing-distance-green.log`).
- **Subsecond calendar/detail agreement:** The model test now uses the exact fixture `2026-03-01T10:00:00.490Z` to `2026-03-01T11:30:27.410Z` and expects 90.4; `rtk pnpm exec vitest run packages/server/src/models/activity.test.ts` passed 20/20 before and after the SQL correction (`/tmp/kilter-task3-duration-model-red.log`, `/tmp/kilter-task3-duration-model-green.log`). The new real-engine test in `activities-calendar-repository.integration.test.ts` first failed against the seconds expression: expected 90.4, received 90.5. That full RED file run also hit ClickHouse's 1.21 GiB memory ceiling in an unrelated pagination case (7 passed, 2 failed; `/tmp/kilter-task3-calendar-precision-red.log`). After changing only `duration_min` to `dateDiff('millisecond', ...)/60000.0`, the focused real-engine command `rtk pnpm test:integration packages/server/src/repositories/activities-calendar-repository.integration.test.ts -t 'matches server detail duration at sub-second boundaries'` passed 1 test with 8 skipped (`/tmp/kilter-task3-calendar-precision-green.log`). The post-fix full file first passed 9/9 with one transient memory rejection retried by the unchanged runner (`/tmp/kilter-task3-calendar-precision-suite-green.log`); a final run without concurrent ClickHouse work passed all 9 tests without retry or memory rejection (`/tmp/kilter-task3-calendar-precision-suite-final.log`).

## Final checks

- `rtk pnpm --dir packages/web typecheck` — passed (route type generation and TypeScript).
- `rtk pnpm --dir packages/mobile typecheck` — passed.
- `rtk pnpm --dir packages/server typecheck` — passed.
- `rtk pnpm exec biome check <19 changed TypeScript files>` — passed; no fixes required on the final check.
- `rtk pnpm lint:web-stories` — passed.
- `rtk pnpm check:mobile-app-routes` — passed.
- `rtk pnpm provider-derived-metric-policy` — passed.
- `rtk git diff --check` — passed.
- An extra CSpell check over both edited docs reported 460 dictionary findings across the long documents. No dictionary exceptions were added; the required code-format, type, story, route, and metric-policy checks pass.

## Stories for lead review

- Web connected header: `pages-activitydetail-activityheader--connected-kilter-gym-session` — Kaya primary, WHOOP source, two independent Kilter session contributions, raw member links, 55-minute measured duration, 138/168 bpm, no cycling measurements.
- Web standalone header: `pages-activitydetail-activityheader--standalone-kilter-session` — Kilter-only provenance, one logged instant, null end and duration.
- Web unknown-duration card: `activities-activitycardcontent--climbing-unknown-duration` — Kilter-only attribution, visible unknown duration, no TSS.
- Mobile connected header: `pages-activitydetail-activitydetailheader--connected-kilter-gym-session` — Kaya primary, WHOOP source, two independent Kilter sessions with matching IDs.
- Mobile standalone header: `pages-activitydetail-activitydetailheader--standalone-kilter-session` — Kilter-only provenance and one logged instant.
- Mobile unknown-duration card: `components-activitycard--climbing-unknown-duration` — Kilter climbing with unknown duration and no distance measurement.

## Self-review and remaining concerns

The changed diff adds no session-grouping logic, client metric arithmetic, new queries, persisted values, or stale-fixture compatibility defaults. It changes only the calendar `duration_min` SELECT expression to use millisecond precision, matching the server model's one-decimal duration. Duration comes from the server DTO; timestamp and window formatting remain client-side. Measured distance remains visible on climbing cards. Production behavior and recovery have not been verified in this worker task. Lead-owned Storybook DOM/accessibility review remains the visual acceptance step; this host's screenshot capture limitation is recorded by the lead.

## Retrospective

The brief, CodeGraph location checks, and RED logs made the core implementation direct. Review of rendered stories caught two requirements that source-only checks would miss: the exact provider label and irrelevant inherited ride facts. For similar work, include representative provider labels and visible unknown-state text in acceptance criteria, and inspect both platforms' story DOM. The existing `superpowers:test-driven-development` and `write-tests` skills fit this work; no new skill is needed. A small Task 3 brief clarification to require provider-catalog labels and a no-unrelated-metrics climbing fixture would reduce later fixture corrections.
