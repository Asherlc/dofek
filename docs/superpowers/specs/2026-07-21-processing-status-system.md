# Comprehensive Processing Status System

**Status:** Approved direction

**Goal:** Give users and operators one accurate, durable view of every stage between starting a provider sync/import and seeing current data in the product.

## Product behavior

The product exposes a compact processing-status widget everywhere data readiness matters. The widget preserves already-rendered data while background work runs and expands into a stage-by-stage view showing:

- the provider or import that initiated processing;
- affected user-facing datasets;
- current stage and progress;
- when each completed stage finished;
- whether remaining work is expected, delayed, blocked, or failed;
- a specific user-facing failure message and retry action when one exists;
- the last time each affected dataset was fully ready.

The provider detail view filters the widget to that provider. Dataset pages filter it to the datasets they render. The providers overview can display the account-wide state. Unrelated provider jobs never appear as if they are blocking the current page.

## Processing model

### Operations

A processing operation is a durable, user-scoped unit of work initiated by a provider sync, file import, push ingest, or data deletion. It has a stable UUID and optional external correlation key such as a BullMQ job identifier or upload identifier.

System-wide analytics builds and cache refreshes are durable operations without a user owner. They are linked to user operations through the source watermark they cover, rather than by copying provider data into analytics state.

### Append-only stage events

Operational facts are stored as append-only events. Current state is derived from the latest event for an operation/stage/dataset tuple. This avoids maintaining mutable and historical versions of the same fact.

Each event records:

- operation identifier;
- stage;
- status;
- optional dataset key and model name;
- occurrence time;
- optional progress percentage;
- optional source/serving watermark;
- sanitized message, error code, and error message;
- schema-versioned structured metadata for stage-specific evidence.

The persisted stages are:

1. `ingest`
2. `canonical_commit`
3. `cdc`
4. `analytics`
5. `cache_refresh`

Persist only factual lifecycle states: `queued`, `running`, `succeeded`,
`failed`, `cancelled`, and `skipped`. The projection derives `waiting`,
`delayed`, `blocked`, and `ready` from those facts, dependency evidence, and
stage deadlines. Empty/no-data is a dataset result, not a processing failure.

### Dataset contracts

A typed registry defines every user-facing dataset and its dependencies. It is the canonical mapping used by the API, reconciler, tests, and clients. A contract includes:

- stable dataset key and layman-readable label;
- source tables or ingest streams;
- ClickHouse mirror flow/table dependencies;
- required dbt serving models;
- registered API query families whose caches must be refreshed;
- applicable providers/data types;
- expected processing/freshness target;
- web and mobile consumers.

Internal dbt models are represented in analytics-run detail, while the user widget summarizes them under the user-facing dataset contracts they support.

## Stage completion rules

- **Ingest:** the provider/import worker emits started, progress, succeeded, or failed events. BullMQ jobs remain small, atomic, and idempotent so a retry has the same final result ([BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs), [BullMQ flows](https://docs.bullmq.io/guide/flows)).
- **Canonical commit:** the canonical health rows, commit-stage event, and one CDC marker for each affected PeerDB flow are inserted in the same Postgres transaction. This avoids a dual write where data commits without its durable processing evidence ([AWS transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)). The operation watermark is ingestion/commit identity, not the health record's domain timestamp, so historical imports remain observable.
- **CDC:** complete only when every required ClickHouse mirror contains the exact operation marker written by the source transaction. Replication-slot health and unrelated newer `_peerdb_synced_at` values are supporting evidence, not proof that a user's transaction arrived.
- **Analytics:** complete when every model required by the dataset succeeded in a dbt run that began after the CDC marker became visible. Per-model results come from Zod-validated `run_results.json`, mapped through `manifest.json`; source evidence comes from `sources.json`, never log-text parsing. Because only executed nodes appear in run results, the attempted selection is reconciled against the manifest, and each invocation writes to a distinct artifact directory ([dbt run results](https://docs.getdbt.com/reference/artifacts/run-results-json), [dbt state and source status](https://docs.getdbt.com/reference/node-selection/configure-state)).
- **Cache refresh:** complete when every registered query family required by the dataset has been refreshed successfully after the analytics run.
- **Ready:** derived by the reconciler only after all required stages succeed. A failed or blocked stage remains visible even if an unrelated operation is running.

## API

`processing.status` accepts optional `providerId` and `datasets` filters and returns:

- generated time and requested scope;
- overall status using failure-first precedence;
- active and recently completed operations;
- per-dataset current stage, status, progress, source/serving watermarks, last-ready time, and delay;
- stage timeline and sanitized failure information;
- model-level detail for operator/admin callers only.

`processing.history` provides bounded, cursor-paginated operation history. Retention is explicit; the first implementation keeps stage events for 90 days and preserves one terminal operation summary per provider/dataset beyond that only if a later requirement justifies it.

The API never reports CDC and analytics lag from the same value. Unknown evidence remains unknown rather than being labeled healthy.

## UI

The canonical widget is implemented on both web and mobile with shared formatting/state logic in `@dofek/providers`.

Compact state:

- `Ready` is visually quiet and normally hidden unless the host requests an always-visible status.
- Active processing shows the current stage, affected scope, and progress.
- Delayed processing shows what it is waiting for and when it last advanced.
- Failed or blocked processing takes precedence and provides an actionable message.

Expanded state shows a vertical stage timeline, per-dataset rows, exact timestamps, and recent operations. Technical model names and infrastructure terminology are excluded from normal user copy.

The widget does not replace query-level loading or error states. Existing data remains rendered during background processing.

Clients poll adaptively while work is active, slow down while delayed, and stop
after terminal state rather than introducing a second real-time transport
([TanStack Query polling](https://tanstack.com/query/v5/docs/framework/react/guides/polling)).
Determinate work uses progress-bar semantics; indeterminate work omits a
numeric value. Material status changes use a polite live region without moving
focus or announcing every percentage update
([W3C status-message technique](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA25)).

## Reliability and observability

- Event creation is idempotent through an operation/stage/dataset/status/idempotency-key constraint and ordered by a monotonic sequence, not wall-clock timestamps alone.
- Provider/import commit events and CDC markers are written in the same transaction as canonical data; queue dispatch uses the existing transactional-outbox pattern.
- Unexpected instrumentation failures are reported to Sentry and fail the owning operational step when correctness would otherwise become unknowable.
- A reconciler advances CDC, analytics, cache, and ready stages from durable evidence and is safe to run repeatedly.
- Metrics cover operations by stage/status, stage duration, stalled operations, model failures, and reconciliation failures.
- OpenTelemetry trace/span identifiers may be retained as metadata for correlation, without making telemetry the source of truth. Producer and consumer spans use trace links for asynchronous/batched work ([OpenTelemetry messaging spans](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)).

## Security and privacy

- Every user-facing query is scoped by authenticated user ID.
- Messages are sanitized before persistence and response.
- Metadata must not contain credentials, provider payloads, raw health samples, filenames containing personal information, or arbitrary exception objects.
- Model-level operational details are restricted to administrative/operator contexts.

## Migration and compatibility

The new processing API and widget replace `sync.dataHealth` and `DataReadinessBanner` once parity tests pass. There is one canonical status system; no long-lived dual-read compatibility layer is introduced. Historical operations begin when instrumentation deploys—existing sync logs are not reinterpreted as processing events.

## Non-goals

- Predicting an exact completion time without measured stage history.
- Persisting duplicate health or analytics values in Postgres.
- Treating a running provider job as proof that a particular dataset is stale.
- Exposing raw dbt, PeerDB, Redis, or ClickHouse terminology to ordinary users.
- Adding Temporal alongside BullMQ solely for status reporting. Temporal is appropriate if pipeline execution is intentionally migrated to one durable workflow engine, not as a parallel observer ([Temporal workflow execution](https://docs.temporal.io/workflows)).
