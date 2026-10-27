# Background Jobs

This directory contains background job processing logic using BullMQ and Redis.

## Job Types

- **Sync**: Periodic data synchronization with provider APIs (e.g., Strava, Fitbit).
- **Push delivery**: Official Garmin Health/Activity notifications enter the dedicated provider queue and use the shared worker processing flow; they do not trigger window polling. See the [Garmin provider](../providers/garmin/provider.ts) and [operator guide](../../docs/garmin.md).
- **Import**: Processing uploaded files (Apple Health XML, Strong CSV, Cronometer CSV).
- **Export**: Generating user data ZIP exports.
- **Scheduled Sync**: High-level orchestrator for triggering periodic syncs based on tiers.
- **Post-Sync**: Downstream tasks (e.g., recomputing metrics, cache invalidation) triggered after a successful sync.
- **Activity Delete Analytics**: Rebuilds ClickHouse activity read models after user-initiated deletes.
- **Analytics Refresh**: Reconciled data dispatches a combined refresh request to
  the dedicated analytics worker. Scheduled maintenance uses the same queue;
  queue-wide concurrency of one serializes these builds. Requests arriving
  during a build form the next batch, following BullMQ's
  [deduplication pattern](https://docs.bullmq.io/patterns/deduplication) and
  [global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency).
- **Provider Data Deletion**: Advances the provider generation fence and tombstones at most 1,000 metric-stream rows per durable continuation job before acknowledging completion.

## Architecture

- **BullMQ**: Job queue management with Redis.
- **Per-Provider Workers**: Each sync provider has its own dedicated BullMQ worker to independently manage concurrency and rate limits.
- **Targeted webhooks**: The HTTP receiver queues each actionable targeted event for the provider worker. The worker calls the provider's targeted sync method when available, then records canonical commits and downstream processing through the same operation used by window syncs. Each event has its own queue ID so cooldowns do not merge unrelated events. Strava requires prompt webhook acknowledgement and recommends asynchronous processing ([Strava webhook documentation](https://developers.strava.com/docs/webhooks/)).
- **Shared sync coordination**: Shared jobs fan out through the existing provider queues with one absolute sync window. BullMQ parent dependencies preserve dispatch through coordinator retries and child pruning; failed provider jobs report independently. The coordinator uses the [waiting-children processing pattern](https://docs.bullmq.io/patterns/process-step-jobs).
- **Sync processing identity**: Each newly created queue job has its own processing operation, correlated by its queue ID, stored creation timestamp, and provider. Retries and continuations reuse the operation ID persisted in job data. A queue ID alone cannot identify a permanent processing record because BullMQ permits reusing it after job removal; see [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids).
- **Credential reconnects**: Generic and WHOOP credential handlers commit renewed tokens inside the account-erasure fence, then reacquire the fence to dispatch a full sync. Each reconnect uses a fresh queue ID so an older active sync or delayed bounded retry cannot absorb the request. Existing provider cooldown delays still apply; see [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids) and [delayed jobs](https://docs.bullmq.io/guide/jobs/delayed). Garmin uses [official OAuth](../providers/garmin/oauth.ts); its push-only connection does not dispatch a full poll.
- **Redis command deadlines**: Shared nonblocking Redis commands and per-provider sync queue commands have a five-second deadline so stalled dispatch releases the account-erasure transaction. Worker and event-listener connections retain their blocking behavior. BullMQ distinguishes request-facing producers from persistent workers in its [connection guidance](https://docs.bullmq.io/guide/connections); ioredis defines [commandTimeout](https://github.com/redis/ioredis/blob/main/lib/redis/RedisOptions.ts) separately from the connection deadline.
- **Queues**: Defined in `queues.ts` with typed job data interfaces.
- **Workers**: Implemented in `worker.ts` and kept running while queues are idle. The Swarm service maintains a running replica; an idle process exit ends its task and creates an availability gap before replacement ([Docker Swarm services](https://docs.docker.com/engine/swarm/how-swarm-mode-works/services/)).
- **Worker responsibilities**: `worker.ts` coordinates startup;
  `worker-queues.ts` constructs queue processors, `worker-events.ts` handles
  job reporting and deletion redrive, and `worker-lifecycle.ts` handles graceful
  signal shutdown and unhandled rejection reporting.
- **Bounded shutdown**: BullMQ workers stop accepting new jobs and wait for bounded active work. Production gives that drain 30 minutes before Docker can force-kill the task; provider requests have a two-minute deadline and multi-hour provider deletion is split across durable batch jobs. See [BullMQ graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown) and [Docker `stop_grace_period`](https://docs.docker.com/reference/compose-file/services/#stop_grace_period).
- **Processor Functions**: Each job type has a dedicated processor (e.g., `process-sync-job.ts`).
- **Sync responsibilities**: `process-sync-job.ts` coordinates provider jobs;
  `sync-job-context.ts` resolves sync windows and manages checkpoints,
  `sync-processing-operation.ts` tracks ingestion stages,
  `sync-provider-execution.ts` executes and records provider results, and
  `sync-provider-failure.ts` applies failure and retry policy. Each module has
  a matching colocated unit test.

## Provider execution ordering

Provider workers, the shared sync worker, and the inline CLI worker serialize
one complete execution for each owner/provider before its first source request
through persistence. Independent keys can proceed concurrently within the
existing four-session guard pool. A waiting execution consumes one of those
sessions; this change adds no connections. A coordinator without a provider
continues to fan out through provider queues. PostgreSQL session advisory locks
provide exclusion across processes without holding a database transaction during
HTTP work ([PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)).

The guard acquires the provider lock before the shared account-erasure work
barrier, checks the erasure fence, and releases both in reverse order after the
callback. It verifies each unlock and destroys a session whose ownership cannot
be confirmed. If any checked-out work-lock session disconnects, the worker
reports the exception and exits synchronously to prevent an outstanding
callback from persisting after provider exclusion or the account-erasure barrier
is lost. This also protects account-only jobs such as imports and exports. Telemetry delivery is best
effort at that boundary: immediate exit cannot wait for asynchronous flushing
([node-postgres client errors](https://node-postgres.com/apis/client#events),
[Node.js process.exit](https://nodejs.org/api/process.html#processexitcode)).

Mountain Project fetches and persists its full snapshot in one execution, so the
guard orders that complete refresh. WHOOP carries checkpoints across
separate jobs; execution locking does not order an entire logical refresh across
those continuations ([BullMQ step jobs](https://docs.bullmq.io/patterns/process-step-jobs)).

Garmin instead validates each delivery's current owner, authorization, permission,
and provider-data generation before writing. Reconnects and provider-data deletion
therefore invalidate queued stale deliveries. The
[receiver](../../packages/server/src/routes/garmin-webhooks.ts),
[authorization checks](../providers/garmin/authorization.ts), and
[provider](../providers/garmin/provider.ts) define that lifecycle. Retained FIT
artifacts belong to the user/provider and are removed by provider-data deletion
or account erasure; see [artifact storage](../provider-artifact-storage.ts) and
the [Garmin operator guide](../../docs/garmin.md).

All FIT sources now share the same durable-original requirement: the
[FIT importer](process-fit-file-import-job.ts) archives the complete file before
native decoding. Provider downloads, manual FIT uploads and extractable Garmin
ZIP members use the existing owner/provider artifact prefix; official Garmin
delivery reuses its already-retained object. Malformed/unsupported FITs remain
retained, and archive failures prevent decoding. Temporary staging/upload cleanup
is separate from durable artifact deletion. See the
[FIT retention policy](../fit/README.md#original-file-retention) for identity,
reprocessing and historical-data limits.

## Configuration

- **Provider Tiers**: Sync frequency and priority are defined in `provider-queue-config.ts`.
- **Push-only queues**: Queue registration and scheduled eligibility are distinct. Garmin still needs an on-demand provider queue/worker, while `pushOnly` excludes scheduled and manual polls. See [queue configuration](provider-queue-config.ts), [worker construction](worker-queues.ts), and [sync eligibility](../providers/index.ts).
- **Concurrency**: Per-queue concurrency limits for rate-limiting API calls.
- **Retry Logic**: Sync and post-sync jobs use a fixed five-minute backoff;
  provider-deletion and activity-analytics jobs use a fixed 30-second backoff.
  Other queues declare retry options at their enqueue sites. BullMQ documents
  fixed backoff and attempt handling in
  [retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs).

## Provider Issue Emails

The shared [sync logger](../db/sync-log.ts) checks completed, overall provider
failures for user notification. Authorization failures send an email immediately;
other issues send one after two scheduled failures since the last successful
overall sync. Manual errors and individual data-step errors do not count toward
that threshold. A successful manual or scheduled overall sync allows a later
issue to trigger a new alert. See the
[notification implementation](../db/provider-issue-notification.ts) and its
[database integration tests](../db/provider-issue-notification.integration.test.ts).

Emails name the provider, explain whether reconnection is required, and link to
its page on `https://dofek.fit`. They use the existing `BREVO_API_KEY` and
`EXPORT_EMAIL_FROM` worker configuration and Brevo's
[transactional email API](https://developers.brevo.com/docs/send-a-transactional-email).
Upstream error payloads are kept out of email content.

`fitness.provider_issue_email` records the email accepted by Brevo for each
connection's active issue. A transaction serializes notification decisions,
applies the existing account-erasure fence, and records acceptance after sending.
An overall success clears the marker in the same transaction as its sync log.
Both logging and delivery acquire the user fence before the connection lock.
Its connection foreign key removes that state on disconnect or account deletion.
See PostgreSQL
[transaction locks](https://www.postgresql.org/docs/current/explicit-locking.html)
and [foreign keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK).
Concurrent attempts and later failed syncs suppress repeat alerts until recovery.
If a worker stops after Brevo accepts an email but before acceptance is recorded,
a later sync may send it again.

Email requests have a 30-second deadline so a stalled sender cannot hold the
notification transaction indefinitely. Missing recipient addresses are skipped.
Delivery errors are reported to Sentry with `operation=provider-issue-email` and
logged without changing the recorded provider outcome; a later failed sync tries
delivery again while the issue remains active. The shared backend applies the
same notification policy for web and mobile users.
