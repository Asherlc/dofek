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

Operational facts are stored as append-only events. Current state is derived from the latest event for an operation/stage/dataset/output-path tuple. This avoids maintaining mutable and historical versions of the same fact.

Each event records:

- operation identifier;
- stage;
- status;
- optional dataset key and model name;
- optional output path (`relational` or `metric_stream`);
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
- independent source/output paths and the evidence each path requires;
- applicability rules based on outputs the operation actually emitted;
- Postgres/PeerDB dependencies for relational output and Redpanda/ClickHouse dependencies for metric-stream output;
- required dbt serving models;
- registered API query families whose caches must be refreshed;
- applicable providers/data types;
- expected processing/freshness target;
- web and mobile consumers.

Internal dbt models are represented in analytics-run detail, while the user widget summarizes them under the user-facing dataset contracts they support.

Relational records and metric-stream samples are independent canonical facts. An activity may legitimately have no sensor samples, and sensor samples may legitimately have no activity. A processing operation therefore records an output manifest describing what it actually emitted. Dependencies are conjunctive only within an emitted output path; the system must not infer that producing one path requires the other.

## Stage completion rules

- **Ingest:** the provider/import worker emits started, progress, succeeded, or failed events. BullMQ jobs remain small, atomic, and idempotent so a retry has the same final result ([BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs), [BullMQ flows](https://docs.bullmq.io/guide/flows)).
- **Canonical commit:** each emitted output path records its own canonical evidence. After relational provider/import writes complete, the worker writes a durable causal-fence transaction containing the commit-stage event, current Postgres WAL location, and one exact marker for each affected PeerDB flow. This fence does not duplicate provider rows and is not coupled to metric-stream publication. Metric-stream publication remains on the existing Redpanda path and records stable operation and batch identifiers acknowledged by the broker; metric samples are never routed through Postgres merely to coordinate status. The operation watermark is ingestion/commit identity, not the health record's domain timestamp, so historical imports remain observable. PostgreSQL LSNs are monotonically increasing WAL positions ([PostgreSQL WAL internals](https://www.postgresql.org/docs/current/wal-internals.html)); Kafka-compatible ordering is guaranteed only within a partition ([Apache Kafka introduction](https://kafka.apache.org/documentation/)).
- **CDC:** relational output completes only when every applicable ClickHouse mirror contains the exact operation marker written by its source transaction. Metric-stream output completes only when ClickHouse contains the exact sink acknowledgement for every batch/partition the operation published. Replication-slot health, broker publication alone, and unrelated newer timestamps are supporting evidence rather than proof that a specific output arrived.
- **Analytics:** complete when every model required by the dataset succeeded in a dbt run after CDC evidence became visible. Per-model results come from Zod-validated `run_results.json` mapped through `manifest.json`, never log-text parsing. Because only executed nodes appear in run results, the attempted selection is reconciled against the manifest, and each invocation writes to a distinct artifact directory. `sources.json` is consumed only when a separate source-freshness command produces it ([dbt run results](https://docs.getdbt.com/reference/artifacts/run-results-json), [dbt manifest](https://docs.getdbt.com/reference/artifacts/manifest-json)).
- **Cache refresh:** complete when every registered query family required by the dataset has been refreshed successfully after the analytics run.
- **Ready:** derived by the reconciler only after all stages required by the operation's emitted output manifest succeed. A legitimately absent output path is `skipped`, not failed or waiting. A failed or blocked stage remains visible even if an unrelated operation is running.

## API

`processing.status` accepts optional `providerId` and `datasets` filters and returns:

- generated time and requested scope;
- overall status using failure-first precedence;
- active and recently completed operations;
- per-dataset current stage, status, progress, source/serving watermarks, last-ready time, and delay;
- stage timeline and sanitized failure information;
- model-level detail for operator/admin callers only.

`processing.history` provides bounded, cursor-paginated operation history. The first implementation does not physically purge the append-only ledger; `processing.status` limits its active projection to operations created in the last 90 days while history remains available. A later retention job requires separate review before deleting facts.

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
- Relational commit events, exact PeerDB markers, and reconciliation outbox rows share one causal-fence transaction after the provider/import database write completes. Metric publication and its ClickHouse receipt remain independent.
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
- Routing metric-stream payloads through a Postgres outbox solely to coordinate processing status.
- Requiring relational activity records and metric-stream samples to exist together.
- Treating a running provider job as proof that a particular dataset is stale.
- Exposing raw dbt, PeerDB, Redis, or ClickHouse terminology to ordinary users.
- Adding Temporal alongside BullMQ solely for status reporting. Temporal is appropriate if pipeline execution is intentionally migrated to one durable workflow engine, not as a parallel observer ([Temporal workflow execution](https://docs.temporal.io/workflows)).
