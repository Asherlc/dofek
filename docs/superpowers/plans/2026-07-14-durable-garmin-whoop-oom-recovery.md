# Durable Garmin Import and Worker Readiness TDD Plan

> **Issue:** [#1606 — Make Garmin imports durable and bound WHOOP heart-rate memory](https://github.com/Asherlc/dofek/issues/1606)
>
> **Status:** Complete. The accepted incident scope is implemented test-first and all local validation gates pass.

## Outcome

Replace the worker healthcheck's second Node runtime with readiness served by the existing worker process, and make Garmin dump imports recover safely when that worker exits at any point in the FIT child flow.

WHOOP response streaming is not part of this incident fix. Production evidence did not show the fatal WHOOP response body resident at the kill, while cgroup accounting directly identified the healthcheck process as the missing memory ([incident evidence](../../incidents/2026-07-14-worker-oom-evidence.md#production-capture)). Any future WHOOP memory work requires a separate issue and independent baseline.

## Evidence and root cause

The production worker was killed at `2026-07-14T20:15:51.556Z` with `OOMKilled=true` and exit code `137`. The cgroup reached its exact 400 MiB limit: the main Node worker held 344,543,232 anonymous bytes, the healthcheck's second Node runtime held 65,556,480 anonymous bytes, and kernel memory accounted for the remainder ([incident evidence](../../incidents/2026-07-14-worker-oom-evidence.md#production-capture)). Docker health commands execute inside the service container, so both runtimes shared the same configured memory limit ([Docker healthcheck reference](https://docs.docker.com/reference/compose-file/services/#healthcheck), [Docker memory constraints](https://docs.docker.com/engine/containers/resource_constraints/)).

The restart exposed a second defect. The Garmin parent recreated 948 unfinished extraction children because FIT and batch IDs were deterministic but extraction IDs were not. Those FIT jobs then observed two extraction results and failed ([incident record](https://github.com/Asherlc/dofek/issues/1606)). BullMQ custom IDs are intended to suppress duplicate additions, and colons are prohibited in those IDs ([BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids)).

Definitive root cause: the ten-second healthcheck launched a second fully instrumented Node runtime while the long-lived worker was near its cgroup limit; after the resulting kill, non-deterministic extraction IDs made the Garmin recovery non-idempotent.

## Accepted design

### Worker readiness

The worker process owns a loopback-only `GET /readyz` endpoint. Each request checks every already-created BullMQ Worker without constructing a Queue, QueueEvents, Sentry runtime, or child process:

- `worker.isRunning()` proves the worker loop is active.
- `worker.waitUntilReady()` verifies its blocking Redis connection.
- `worker.client.status` verifies its command connection is ready.
- `LLEN worker.toKey("wait")` executes a bounded Redis round trip on that existing client.
- The whole probe times out after 2.5 seconds and returns HTTP 503 on failure.

Swarm uses BusyBox `wget` against `127.0.0.1:3001/readyz`. The separate executable `worker-health.ts` path, process-name inspection, and direct-run Sentry initialization are removed. Docker treats non-zero health command exits as failed checks ([Dockerfile HEALTHCHECK](https://docs.docker.com/reference/dockerfile/#healthcheck)).

### Durable Garmin parent

~~~text
import parent
  active: parse/index archive, write summaries, persist checkpoint
  active: attach deterministic batch/FIT/extraction subtree
  waiting-children: no worker lock and no polling interval
    batch
      FIT children
        extraction child
  active again: read batch result, clean temporary files, log and finalize
~~~

The import job is the external parent of a BullMQ Flow. It persists a Zod-validated versioned checkpoint before attachment and again after attachment. It then calls token-bound `moveToWaitingChildren()` and throws `WaitingChildrenError` only when BullMQ reports unresolved dependencies. This is BullMQ's documented process-step pattern ([process-step jobs](https://docs.bullmq.io/patterns/process-step-jobs), [flows](https://docs.bullmq.io/guide/flows)).

Every batch, FIT, and extraction job ID is a colon-free SHA-256 identifier derived from the user, upload, and source entry. Retention is age-based only; a count cap cannot evict deterministic children from a 1,294-file flow while its parent is still recoverable.

Crash boundaries:

- Before the prepared checkpoint: preparation runs again.
- After the prepared checkpoint and before attachment: preparation and deterministic attachment run again.
- During or after attachment: duplicate adds resolve to the existing jobs.
- While children run: the import parent is in `waiting-children` and owns no expiring lock.
- If children finish before the parent yields: `moveToWaitingChildren()` returns false and the same activation finalizes.
- After reactivation: the persisted batch ID locates the bounded child result without rebuilding the flow.

### Progress and failure truth

Preparation reports 0–45 percent. FIT job completion/failure events feed an in-process coordinator that reads authoritative batch dependency counts and updates the waiting import parent across 45–90 percent. Updates are debounced to one per two seconds, monotonic, and reconciled when the worker starts. Progress errors are reported to Sentry but never change import state.

Deterministic payload, extraction, decode, parse, and timestamp failures throw BullMQ `UnrecoverableError`. Filesystem and database failures propagate normally. Extraction failure text is carried through the FIT failure instead of being replaced with a generic missing-child message. Successful siblings remain completed because each dependency uses `ignoreDependencyOnFailure`.

The batch combines successful return values with `getIgnoredChildrenFailures()`. It normalizes and groups repeated causes, sorts them deterministically, and returns no more than ten user-visible errors, including an exact omitted-count summary. The import parent writes terminal sync history, removes upload/temp files, schedules normal post-import work, then fails non-retryably when the bounded result contains errors.

### Bull Board and worker evidence

Bull Board registers the FIT, FIT-batch, and ZIP-extraction queues. Failed, stalled, and lock-renewal events are reported to Sentry and the application logger; detailed causes are also appended to BullMQ job logs with bounded retention. Parent phase logs record preparation, attachment, waiting, and finalization. BullMQ exposes job logs through its Job API ([BullMQ Job API](https://api.docs.bullmq.io/classes/v5.Job.html)).

## TDD evidence

| Behavior | Red proof | Green proof |
|---|---|---|
| In-process readiness | Missing readiness module; stopped/reconnecting/hung Worker clients had no endpoint behavior | HTTP tests cover ready, stopped Worker, blocking client, command client, Redis failure, timeout, and unrelated paths |
| Import-worker handoff | Garmin branch still entered the polling importer and deleted the upload while yielding | Durable processor delegation retains uploads only in `waiting-children` and runs terminal side effects once |
| Token-bound parent operations | Wrapper omitted ID, queue key, checkpoint updates, child reads, and waiting transition | Wrapper exposes the exact token-bound BullMQ operations and bounded parent logging |
| Crash-safe flow | Parent remained active and extraction IDs could multiply after restart | Unit phase-order tests plus real-Redis parent parking, lock-loss, reactivation, and identical-flow re-add proof |
| FIT failures | Deterministic failures resolved as successful jobs with error arrays; database errors were swallowed | Deterministic failures are unrecoverable; transient persistence failures propagate; exact extraction causes survive |
| Batch result | Ignored failures were absent and successful sibling counts could not be combined with them | Grouped/capped errors preserve successful record counts |
| Progress | Waiting parent stayed at 45 percent | Debounced dependency-count updates and startup reconciliation are monotonic |
| Observability | Child queues were absent from Bull Board and BullMQ Logs were empty | Queue adapters, parent phase logs, failed/stalled/lock log entries, and Sentry paths are covered |

The real-Redis test uses isolated queue prefixes and proves that a parked parent's old lock token returns zero, the parent executes twice, and the batch, FIT, and extraction jobs each execute exactly once after two identical flow re-adds.

## Validation gate

Before integration tests:

```sh
rtk docker compose up -d db redis
rtk docker compose ps db redis
```

Required checks:

```sh
rtk pnpm lint
rtk pnpm typecheck
rtk pnpm test:unit
rtk pnpm test:changed
rtk pnpm vitest run --project integration src/jobs/process-garmin-dump-import-job.integration.test.ts
rtk docker stack config --compose-file deploy/stack.yml
```

The stack-render check supplies required environment variables but does not deploy. No memory-limit increase, retry delay, additional worker service, WHOOP refactor, or warn-and-continue deployment behavior is permitted as part of this fix.

Completed validation:

- `pnpm lint` and all-package typecheck passed in the [complete CI run](https://github.com/Asherlc/dofek/actions/runs/29386899805).
- [Unit validation](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87262093631) passed 11,699 tests in 595 files, with 21 tests and two files skipped by their existing conditions.
- The [unit and integration test gate](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87263034432) passed against real Postgres, Redis, and ClickHouse dependencies.
- The isolated real-Redis restart test passed and proved parent reactivation without the old lock or duplicate child execution.
- All mutation shards passed the [mutation-testing gate](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87263784522), including a [100 percent Stryker shard](https://github.com/Asherlc/dofek/actions/runs/29386899805/job/87262133382) containing the import worker changes.
- `docker stack config --compose-file deploy/stack.yml` rendered successfully with required variables and did not deploy.

## Definition of done

- Swarm no longer starts a Node healthcheck process.
- Queue readiness still fails closed when any Worker or Redis connection is unavailable.
- The import parent visibly enters `waiting-children` and can resume without its old lock.
- Repeated flow attachment cannot create duplicate batch, FIT, or extraction jobs.
- Partial imports retain successful activities, surface a bounded grouped error, run terminal side effects, and end in BullMQ's failed state.
- Bull Board exposes every Garmin child queue and BullMQ job logs contain actionable phase/failure evidence.
- Unit, integration, type, lint, stack-render, and relevant mutation checks pass.
- The production incident baseline records the root cause, direct fix, validation, and remaining risk.
