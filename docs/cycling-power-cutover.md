# Computed cycling power cutover

The [pure algorithm package](../packages/cycling-power/README.md) contains no
Dofek data access, policy or reference data. The
[application projector](../src/analytics/README.md) is the sole numerical writer
for canonical normalized power and maintained eFTP. Consumers read those results;
bounded interval calculations call the same package.

## Schema and release boundary

[Postgres migration 0175](../drizzle/0175_remove_configured_cycling_ftp.sql) removes
both configured FTP columns and recreates the legacy profile projection without
FTP. Its first-line maintenance marker invokes the existing
[deployment maintenance procedure](../deploy/README.md#deployment).
Old web and worker readers must remain stopped through the schema boundary;
resume only the matching application image. No compatibility writer or manual
FTP fallback exists. PostgreSQL documents
[`ALTER TABLE DROP COLUMN`](https://www.postgresql.org/docs/current/sql-altertable.html).

[ClickHouse migration 0108](../src/db/clickhouse-migrations/0108_computed_cycling_power.ts)
creates versioned NP observations and per-user histories before exposing their
serving views. It removes the three obsolete stored SQL NP columns, drops the
profile mirror FTP column, and makes healthspan minute values nullable. The old
ten-slot daily cycling cache is recreated with the nine-slot current schema;
raw observations are retained. Current-shape reapplication preserves rows.
The [executable migration fixtures](../src/db/clickhouse-migrations/0108_computed_cycling_power.integration.test.ts)
cover fresh bootstrap, populated upgrades and reapplication.

## Recompute and verify

Record activity/curve coverage and the oldest source activity before release.
Use the [existing bounded read-model procedure](clickhouse-read-model-deploy-runbook.md)
for any historical input repair. Schema migrations do not replay raw history,
copy former computed NP, or overwrite Postgres profiles with sensor analytics.

The serialized analytics refresh builds canonical dbt inputs, refreshes at most
100 changed activity observations, and reconstructs compact histories for at most
32 ready users per pass. Pending work prevents processing success and cache
warming. Healthspan activity/week models run only after projection completes.
Deletion/recomputation jobs await that same serialized writer. Native work is
limited to changed inputs; clock-only advancement reuses NP.

Verify zero pending activity/user projections, matching source/model versions,
stable retained date bounds, preserved zero-power observations, and explicit
unavailability for unsupported evidence. Check a historical activity separately
from the current ongoing estimate; display filters cannot alter its threshold.
Critical Power remains a separately named analysis and is never another FTP
source. Confirm web/mobile provenance, uncertainty and unsupported states together.

Both projection tables participate in the existing user-ID-based
[physical account-erasure discovery](../src/account-erasure/clickhouse-erasure.ts).
Atomic insert fences prevent a concurrent projector from recreating erased rows.
Publication views withhold revised NP until a matching complete history exists.

## Numerical policy

Reference data and all Dofek policy live outside the package in
[`cycling-power-policy.ts`](../src/analytics/cycling-power-policy.ts), using the
[frozen original-source manifest](cycling-power-source-manifest.json).
The [research record](cycling-power-algorithms-research.md) documents finite bank
coverage, cohort limitations and the independent decay heuristic. This release
does not claim physiological FTP validation or exact Intervals.icu outputs.

## Regression invariants

Matching whole-ride and full-span interval windows must retain identical missing
power barriers and use the same resampler/NP calculation. A completed activity
imported before its end time must become eligible later the same UTC day without
requiring another source mutation. Corrections/deletions must replay later
thresholds and update affected healthspan weeks outside the normal lookback.
