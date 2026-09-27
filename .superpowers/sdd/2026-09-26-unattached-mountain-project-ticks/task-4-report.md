# Task 4 Report: Keep Unattached Ticks in Climb and Grade Summaries

## Changes

- `getGradeProgression` and `getVolumeByGrade` now combine attached climbing
  entries from canonical activity members with active unattached entries.
- Unattached entries are scoped to the repository user, exclude rows with
  `provider_absent_at`, and use `unattached_date` inside the user's timezone
  date window and any limited-access date window.
- Session summaries and activity detail remain joined through real activity
  members. The PostgreSQL fixture confirms an unattached tick does not create a
  session or appear in activity detail.

## Validation

- Red phase: `pnpm exec vitest run --project unit packages/server/src/repositories/climbing-repository.test.ts`
  failed on the two new unattached-query assertions before the query change.
- Green phase: the same command passed: 29 tests.
- PostgreSQL: `pnpm test:integration -- packages/server/src/repositories/climbing-repository.integration.test.ts`
  passed: 1 test. It seeds an attached send, an active unattached Mountain
  Project send, and an absent unattached tick. Progression and volume include
  the first two; session and activity detail include only the attached send.
- `pnpm exec biome check` on the three changed repository files and
  `git diff --check` passed.
- The first integration attempt exposed a fixture ID mismatch (member activity
  ID versus canonical group ID), corrected in the test setup; rerun passed.
- `pnpm test -- packages/server/src/repositories/climbing-repository.test.ts`
  also ran the known stale static policy suite and reported the pre-existing
  failure in `src/providers/provider-activity-sync-policy.test.ts`:
  “does not clear provider tombstones in provider activity upserts.” That
  unrelated Task 2 failure was not changed.

## Retrospective

The targeted repository tests and real PostgreSQL fixture gave direct evidence
for both inclusion and the session/detail boundary. The activity-group/member
distinction required an extra fixture correction. Next time, integration test
templates for repositories that accept canonical activity IDs would make that
contract easier to apply consistently.

Suggested docs improvement: add a short note to the server integration-test
guidance that climbing detail lookups use canonical group IDs while foreign
keys on climbing entries reference member activity IDs. No change is proposed
to production documentation for this task. The existing
`integration-tests-ready` skill was useful and should remain the recommended
workflow for PostgreSQL behavior.
