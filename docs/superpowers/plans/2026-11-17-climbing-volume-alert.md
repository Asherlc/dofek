# Climbing Volume Increase Alert Implementation Plan

**Goal.** Surface an increase in recorded climbing time beside the volume chart on web and iOS.

**Architecture.** Read canonical activity groups in a fixed 35-local-date window, then evaluate the current and baseline periods on the server. Both clients render the same result from `climbing.volumeIncrease`.

**Tech stack.** PostgreSQL, Drizzle, tRPC, React, React Native and Vitest.

**Spec.** [Climbing volume increase alert](../specs/2026-11-17-climbing-volume-alert-design.md)

## Task 1. Server calculation and query

- [x] Write tests for `evaluateClimbingVolumeIncrease(workouts)` in `packages/server/src/repositories/climbing-volume-increase.test.ts`. A weekly baseline of 240 minutes triggers at 300 minutes. A microsecond below that fails. A 60-minute increase from 480 minutes and a 50% increase from 60 minutes both fall short. Quiet weeks stay in the four-week average and a single active baseline week is insufficient.
- [x] Write PostgreSQL tests for `ClimbingVolumeRepository.getIncrease(now?)` in `packages/server/src/repositories/climbing-volume-repository.integration.test.ts`. Exercise canonical duplicates, log-only and mixed groups, user and activity types, local dates, restricted access, incomplete duration, and a workout that finishes after the evaluation time.
- [x] Run the unit and PostgreSQL tests before implementing. Expect the missing calculation and repository to fail the new tests.
- [x] Implement the evaluator and `ClimbingVolumeRepository` in the corresponding production modules. Use `v_activity_group`, its active member IDs, the account timezone, integer microseconds and the existing date-access window. Return `increase`, `below_threshold` or `insufficient_data`. Active results carry `recentMinutes`, `baselineMinutes` and `increasePercent`.
- [x] Expose the schema-validated `climbing.volumeIncrease` route in `packages/server/src/routers/climbing.ts` without chart input. Verify the router and database tests, review and commit the server task.

## Task 2. Web and iOS callout

- [x] Extend the colocated web route and iOS screen tests. Verify 300 minutes versus 210 displays the same heading and sentence, filtering keeps the fixed alert query, a fresh below-threshold result clears the callout, and mobile pull-to-refresh invalidates the query.
- [x] Run both tests before editing the routes. Expect the callout and its refresh to be absent.
- [x] Render the shared copy and formatted duration beside the chart in `packages/web/src/routes/training/climbing.tsx` and `packages/mobile/app/(tabs)/strain.tsx`. Use the query error panels and retain existing chart states. Exercise the active state in the existing route stories.
- [x] Run the focused unit and mobile tests, review the two platforms and their accessible reading order, then commit the client task.

## Task 3. Review and verification

- [x] Review the complete diff against the spec. Focus on account-local midnight, duplicate workout groups, null dates, stale UI on refresh and isolation from chart filters.
- [x] Verify review fixes for mobile navigation focus, health sync invalidation and replacing a stale alert with an error after failed refresh. Keep the previous alert visible while a refresh is in flight.
- [x] Run `pnpm lint`, `pnpm --recursive --include-workspace-root --if-present typecheck`, the relevant non-interactive unit/mobile tests and the PostgreSQL regression suite.
- [ ] Replay the alert against authorized historical workout data before rollout. This release check is pending.

## Task 4. Add the separate attempts alert

- [x] Verify the approved 25 percent and 10-attempt increase rule, 70 percent coverage in each window and 15-percentage-point coverage gap in unit tests.
- [x] Reuse the canonical attempt projection and return daily counts through `climbing.attemptIncrease`. Exercise baseline dates, untimed logs, provider deduplication and days with missing counts in PostgreSQL.
- [x] Show the attempts alert beside the duration callout on web and iOS. Verify independent rendering and refresh behavior, shared copy, lint and typechecks before pushing.
- [x] Verify review fixes for dated logs attached to hikes, preference-independent deduplication, date-scoped attempt queries and attachment refreshes. Run the existing climbing and strengths repository suites against PostgreSQL.
