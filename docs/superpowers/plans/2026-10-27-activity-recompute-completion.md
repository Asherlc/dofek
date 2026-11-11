# Activity Recompute Completion TDD Plan

**Goal:** Refresh web and mobile activity details after analytics recomputation
actually finishes, while keeping existing data visible during the operation.

**Tracking:** [Issue #3106](https://github.com/Asherlc/dofek/issues/3106).

**Scope:** Follow-up approved during [PR #3103](https://github.com/Asherlc/dofek/pull/3103).
Track the existing background operation, preserve observable terminal outcomes,
and invalidate activity queries on completion on both clients. Implement this
separately from the ride energy-output feature. Do not hold the HTTP mutation
open for a global analytics build or add arbitrary sleeps and retries.

## Current evidence

- The [recompute mutation](../../../packages/server/src/routers/activity.ts)
  returns after enqueueing and invalidating caches. The
  [worker](../../../src/jobs/process-activity-delete-analytics-job.ts) builds
  analytics and invalidates server caches later.
- Both [web](../../../packages/web/src/pages/activity-detail/components/RecomputeActivityButton.tsx)
  and [mobile](../../../packages/mobile/app/activity/[id].tsx) invalidate client
  queries on the enqueue acknowledgement, with no terminal completion signal.
  [TanStack invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)
  refetches active client queries; clearing server caches alone does not trigger it.
- The [queue](../../../src/jobs/queues.ts) removes completed recompute jobs and
  uses a deterministic custom ID. A completion design must address both facts:
  removed jobs cannot provide terminal evidence, while retaining a completed job
  can prevent a later enqueue with the same ID. See
  [BullMQ retention and job IDs](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs).
- Reuse the [operation status normalization](../../../packages/server/src/lib/operation-progress.ts)
  and existing completion-driven client patterns where appropriate. Before coding,
  settle how operation identity and terminal evidence will be retained and owned.

## Acceptance tests before implementation

- [ ] Router/queue tests: the mutation returns a tracked asynchronous operation;
  its status is owned by the requesting user and distinguishes queued, running,
  completed and failed. A different user cannot inspect it.
- [ ] Worker tests: completion becomes observable only after the analytics build
  and cache invalidation succeed. Failures retain an actionable message and telemetry.
- [ ] Real Redis integration: completion remains observable when the client misses
  the transition; a second recompute of the same activity starts new work after
  the first completes. Preserve active-job deduplication as required.
- [ ] Web and mobile tests: enqueue acknowledgement leaves a processing state;
  cached metrics remain visible. Simulated successful completion invalidates the
  activity detail, streams, zones, energy output and related current query data,
  then stops polling. Failed completion shows the server message and ends processing.
- [ ] Navigation/unmount tests: an operation finishing for activity A never updates
  activity B's operation state; background refreshes do not hide cached data.

## Files and verification

Expected boundaries: `packages/server/src/routers/activity.ts`, `src/jobs/queues.ts`,
`src/jobs/process-activity-delete-analytics-job.ts`, existing operation progress
helpers, web `RecomputeActivityButton.tsx`, and mobile `app/activity/[id].tsx`.
Unit tests stay colocated; mobile route tests remain under `app-tests/`.

- [ ] Run failing focused tests before changing each production boundary.
- [ ] Implement the approved terminal-evidence design without a second competing
  operation framework or a synchronous HTTP wait for worker completion.
- [ ] Run `rtk pnpm exec vitest run --project unit packages/server/src/routers/activity.test.ts src/jobs/queues.test.ts src/jobs/process-activity-delete-analytics-job.test.ts`.
- [ ] Run focused web recompute component tests and
  `rtk pnpm exec vitest run --project mobile 'packages/mobile/app-tests/activity/[id].test.tsx'`.
- [ ] Run the executable queue lifecycle integration test through
  `rtk pnpm test:integration -- <integration-test-path>`.
- [ ] Run lint, relevant typechecks, spelling checks and a browser UI check; update
  user-facing docs and existing stories for the final operation behavior.
