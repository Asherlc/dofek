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

The allowed stages are:

1. `queued`
2. `ingest`
3. `canonical_commit`
4. `cdc`
5. `analytics`
6. `cache_refresh`
7. `ready`

Allowed statuses are `waiting`, `running`, `succeeded`, `delayed`, `blocked`, `failed`, and `cancelled`. Empty/no-data is a dataset result, not a processing failure.

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

- **Ingest:** the provider/import worker emits started, progress, succeeded, or failed events.
- **Canonical commit:** emitted only after the database transaction commits. Its watermark is ingestion time, not the health record's domain timestamp, so historical imports remain observable.
- **CDC:** complete when every required mirror has observed the canonical commit watermark or an equivalent source revision. Replication-slot health is supporting evidence, not proof that a user's rows arrived.
- **Analytics:** complete when every model required by the dataset succeeded in a dbt run that started after the CDC watermark. Per-model results come from dbt artifacts, not log-text parsing.
- **Cache refresh:** complete when every registered query family required by the dataset has been refreshed successfully after the analytics run.
- **Ready:** emitted by the reconciler only after all required stages succeed. A failed or blocked stage remains visible even if an unrelated operation is running.

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

## Reliability and observability

- Event creation is idempotent through an operation/stage/dataset/status/idempotency-key constraint.
- Provider/import events are written transactionally where the stage corresponds to a Postgres commit.
- Unexpected instrumentation failures are reported to Sentry and fail the owning operational step when correctness would otherwise become unknowable.
- A reconciler advances CDC, analytics, cache, and ready stages from durable evidence and is safe to run repeatedly.
- Metrics cover operations by stage/status, stage duration, stalled operations, model failures, and reconciliation failures.
- OpenTelemetry trace/span identifiers may be retained as metadata for correlation, without making telemetry the source of truth.

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

