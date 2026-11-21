# Cycling Interval Target Comparison Implementation Plan

> **For agentic workers:** Use superpowers:test-driven-development and implement the approved plan one task at a time. The Architect delegates bounded work to Paseo's Implementer and reviews each diff and its evidence.

**Goal:** Show prescribed cycling watts and time beside recorded power and lap timer duration in existing activity detail views.

**Architecture:** Extend the bounded FIT decoder and importer to persist matched interval evidence. Reuse existing activity visibility, canonical interval resolution and gap-aware power data for the API and both clients.

**Tech stack:** Garmin FIT C++ SDK, TypeScript, Drizzle, Postgres, ClickHouse, tRPC, React, Expo.

**Spec:** [Approved canvas direction and FIT design](../specs/2026-11-21-cycling-interval-target-comparison-design.md)

## Global constraints

- Read local package guidance. Work sequentially on the current branch. Preserve the decoder's 250-message and 512 KiB batch limits and existing acknowledgement and recovery behavior.
- Source eligibility depends on file fields. Existing sync and upload remain the entry points. An archive replay would need its own scope approval.
- All display calculations run on the server. Preserve deduplication, user and activity visibility, existing API fields, and nullable values. The approved web and mobile presentation omits a time-with-power-data column.
- Observe a focused regression fail before making a behavior change. Passing database tests must exercise the real engines. Review each diff before moving on, commit meaningful increments, and push every commit.

## Review focus

- Repeats and shortened laps. Two laps can reference one planned step and remain distinct.
- Unit mixups. A FIT value of 1250 is 250 W, 180000 raw milliseconds is 180 seconds, and a percentage-of-FTP value is ineligible.
- Pauses and missing observations. One recorded lap with 134 timer seconds and 145 elapsed seconds uses each time on its own basis. Missing power stays nullable. Measured zero and a boundary sample have explicit tests.
- Ownership and overlap. A target on a merged member is discoverable only when the activity is visible to the caller. Conflicting plans for a duplicated window keep their evidence and cannot yield a comparison.
- Reimport. Retrying a FIT import replaces its owned interval facts atomically and preserves unrelated rows.

## Task 1 — Qualify a source and decode workout evidence

**Files:** `native/fit-decoder/src/fit-decoder.cpp`, `native/fit-decoder/tests/VerifyProtocol.cmake`, `src/fit/stream-decoder.ts`, its tests and FIT documentation.

- [ ] Use the approved synthetic FIT SDK fixture in the red/green tests. Keep qualification of a device-produced cycling activity with a linked fixed-time step and absolute watt target as a release check. Record the source, FIT type, relevant message and field names, target units, and timing evidence without copying personal file contents into the repository.
- [ ] Add failing real-decoder tests for Workout Step and Lap message batching and required callback acknowledgement. Encode fixed-time raw values of 180000 ms, range bounds 1250 and 1265, and equal bounds 1260. Encode laps with step indexes `0, 0, 1` and timer times `180, 134, 180`. Verify the short lap also records 145 elapsed seconds. Cover a recording without embedded steps, an activity decoded through recovery, and ordinary weight and device records.
- [ ] Add FIT SDK Lap and Workout Step batches to the existing stream and Zod message union. Use the existing sender, receiver and batching limits. Keep the SDK's native field representation explicit at the boundary. Confirm timing scale and subfield handling against the pinned C++ SDK.
- [ ] Run the native protocol suite and focused adapter tests. Update the decoder and FIT import protocol documentation.

## Task 2 — Persist matched interval facts during FIT import

**Files:** `src/jobs/process-fit-file-import-job.ts`, a focused FIT interval module under `src/fit/`, `src/db/schema/activity.ts`, a forward Drizzle migration, and matching import and database tests.

- [ ] Add failing import and storage cases for repeated laps, one range, one point, a mismatched or duplicated step index, an unsupported relative target, a missing timer, and a reimport. Include a noncycling and an unrelated interval row in the regression set.
- [ ] Match a clean single-session cycling file's unambiguous Lap to its Workout Step. Use the raw Lap identity as the distinct occurrence. Decode fixed custom absolute bounds according to the FIT SDK. Validate both bounds before normalizing. Persist the point via `target_power_watts` and the range as an ordered pair, together with planned time, nullable recorded timer time, absolute lap boundaries, source ownership, and FIT field provenance. Inferred intervals have no planned target or time values.
- [ ] Use the existing bounded import spool and an owned atomic source-interval replacement, following the transaction pattern in `src/db/activity-device-observations.ts`. Avoid clearing unrelated interval kinds. Scope the writer to clean eligible FIT imports. Keep the canonical interval schema single-source and append the forward migration. Apply it locally using `pnpm migrate`.
- [ ] Run focused FIT tests and real Postgres integration tests. Review the diff for provenance and retry consistency.

## Task 3 — Serve one authoritative comparison

**Files:** `packages/server/src/repositories/cycling-effort-metrics.ts`, `packages/server/src/repositories/intervals-repository.ts`, the existing cycling MCP output contracts, and `packages/server/src/routers/intervals.ts` or its matching repository.

- [ ] Add failing tests for two linked repeats, missing and zero power, a sample on a shared boundary, hidden activities, and eligible FIT evidence on a merged member. Test a conflict in either range endpoint or planned time as a whole conflicting plan, preserving the source evidence.
- [ ] Extend the canonical interval read path to carry point or range targets and the two time values together. Use the same stored evidence in the cycling metrics API and single-activity comparison. The activity endpoint resolves owned visible member IDs with `ActivityRepository.findSensorWindow` and loads deduplicated cycling samples through the existing cycling effort path. Share the relevant interval and power read functions if needed. Keep other activity analytics out of the single-activity query.
- [ ] Use the existing gap-aware cycling computation for recorded power over the actual half-open lap window. Serve `plannedDurationSeconds`, nullable `recordedTimerDurationSeconds`, nullable `timerDifferenceSeconds`, nullable `averagePowerWatts`, source identity, and a target union of `{kind: "point", watts}` or `{kind: "range", minWatts, maxWatts}`. Keep the comparison and its qualifiers server-authored. Existing interval API fields retain their prior meanings.
- [ ] Run focused repository and MCP tests and real Postgres/ClickHouse route tests. Confirm authorization, missingness and overlap behavior with actual test engines.

## Task 4 — Render the approved activity detail section

**Files:** `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/mobile/app/activity/[id].tsx`, colocated components, Storybook cases, and client tests.

- [ ] Add failing client cases for a range, point, 2:14 recorded against 3:00 planned, and the missing-power row. Check that no section appears when there are no eligible rows.
- [ ] Render the approved section in both existing activity detail views. Display an interval label, planned and recorded power, and timer duration. Preserve exact text values as alternatives to chart marks. Match the approved artboard's row structure and use the shared formatters. Keep errors and loading states in the established activity detail patterns.
- [ ] Verify both clients, keyboard and screen reader labels, and narrow view behavior. Run targeted noninteractive test suites, all workspace typechecks, and `pnpm lint`. Review the whole change against the design and confirm the source qualification before asserting support for a live recording.
