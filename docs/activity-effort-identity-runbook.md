# Activity effort identity historical refresh

Use this procedure to audit retained activity payloads and selectively refresh
the dbt-owned repeated-effort identity models. It is intentionally separate
from migrations: deploy migrations remain schema-only, while dbt incremental
models are explicit operational work. See the [database migration policy](schema.md),
the [analytics model inventory](../analytics/README.md), and dbt's
[incremental-model guidance](https://docs.getdbt.com/docs/build/incremental-models).

## Scope and limits

The audit requires one user UUID and a half-open UTC window no longer than 31
days. It reads active `fitness.activity.raw` records in the requested
date/provider scope, including records with `NULL` or all-zero `group_id`
values so invalid group IDs can be reported for diagnostics. It does not fetch
provider data, mutate raw payloads, update Postgres activity rows, or insert
directly into `analytics.activity_effort_identity`.

The v1 map is deliberately the same as
[`activity_effort_identity`](../analytics/models/read_models/activity_effort_identity.sql):

- provider workouts: `pelotonClassId`, `templateId`, `workoutTemplateId`, and `classId`;
- provider routes: `routeId` and `courseId`;
- segments: `segmentId`; and
- standardized tests: `standardizedTestId` and `testId`.

`external_id` and generic payload IDs are provider-instance provenance, not
reusable effort identities. Unknown fields remain untouched in `raw`. The audit
counts an activity with no mapped non-empty string, including a `NULL` raw
payload, as `skipped`; its bounded detail output identifies the source field and
value that could not produce an exact identity. It reports each source claim
when members in one canonical group provide different values for the same
provider, identity kind, and mapped source field. A conflict is evidence to
surface, never a reason to discard a source payload.

The audit also checks the persisted canonical-group prerequisite used by
`activity_source_records`. A `NULL` or all-zero `group_id` makes
`refresh_ready=false`; the command reports the affected source and exits before
an operator can run a dbt refresh that would reject the same record.

## Audit

Run the dry-run audit from an environment with the normal database secrets:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/backfill-activity-effort-identities.ts \
  --user-id=<user-uuid> \
  --start=2026-09-01T00:00:00.000Z \
  --end=2026-09-02T00:00:00.000Z
```

The result reports `scanned`, `skipped`, observed `conflicts`, and
`refresh_ready`. It emits structured per-record details for unsupported values,
canonical-group violations, and conflicting claims, capped at 100 details with
`details_truncated=true` when more exist. Under this read-only design,
`inserted` and `updated` are always zero. `--execute` is an explicit audit
acknowledgement only; it still makes no data writes:

```bash
pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/backfill-activity-effort-identities.ts \
  --user-id=<user-uuid> \
  --start=2026-09-01T00:00:00.000Z \
  --end=2026-09-02T00:00:00.000Z \
  --execute
```

Stop if `refresh_ready=false`, conflicts, or skips are unexpected. A provider
whose retained payload does not contain one of these fields remains uncovered;
recoverability through that provider's network API is a separate
provider-specific operation and is not part of this procedure.

## CDC and dbt materialization

The audit does not change the source, so a normal dirty-key analytics cycle is
not a historical refresh. First confirm the current CDC path is healthy:

```bash
pnpm tsx scripts/with-env.ts -- pnpm check:clickhouse-cdc
```

Obtain the source activity IDs or canonical `group_id` values for the reviewed
window through an approved read-only database session. The scope macro accepts
either form with the same user ID. Then run the models in dependency order in
the analytics environment, replacing the placeholders with the reviewed IDs:

```bash
pnpm tsx scripts/with-env.ts -- env \
  DBT_TARGET=dev \
  UV_PROJECT_ENVIRONMENT=../.venv-analytics \
  uv run --project analytics dbt build \
  --project-dir analytics \
  --profiles-dir analytics \
  --threads 1 \
  --vars '{"activity_refresh_user_id":"<user-uuid>","activity_refresh_activity_ids":["<activity-or-group-uuid>"]}' \
  --select activity_source_records activity_effort_identity activity_route_identity
```

For production, run the same bounded command from the production analytics
environment with `DBT_TARGET=prod`; do not point local credentials at
production. `activity_source_records` refreshes the selected source members,
`activity_effort_identity` materializes their exact claims, and
`activity_route_identity` refreshes explicit route/course evidence for the
affected cycling groups. The scope contract is defined by the
[`activity_refresh_scope` macro](../analytics/macros/activity_refresh_scope.sql),
and the CDC prerequisite and recovery checks are in the
[ClickHouse CDC health runbook](clickhouse-cdc-health-runbook.md).

Verify the selected source records and identity rows after the build. The
projection keeps conflicting source claims separate, so inspect conflict output
through the repeated-effort MCP tools rather than trying to merge values by
hand. See [MCP operations](mcp.md) and the [ClickHouse read-model deploy
runbook](clickhouse-read-model-deploy-runbook.md).

## Rollback

There is no backfill key or identity row to delete: this audit creates no rows,
and dbt is the only writer of `analytics.activity_effort_identity`. Do not
delete projection rows manually. If an underlying retained raw payload is
corrected through its canonical ingestion path, wait for CDC and rerun the same
bounded scoped dbt command; its lifecycle reconciliation replaces stale model
rows. If no raw correction is available, retain the missing or conflicting
state as provenance rather than fabricating a provider identity.
