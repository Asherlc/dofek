# Application analytics orchestration

[`cycling-power-projector.ts`](cycling-power-projector.ts) computes and stores
normalized-power observations for changed completed activities with power,
including cycling activities whose coverage is unavailable. It processes at
most 100 activities per batch. The separate
[`cyclingPowerSuggestionPolicy`](cycling-power-policy.ts) retains the reference
curves and candidate limits for the explicitly requested settings suggestion;
it is not part of the ongoing projection.

The activity-power serving view joins current observations with canonical
activity metadata. It serves normalized power only; manual FTP and its dependent
metrics are resolved by application consumers. The current schema is defined
by [`cycling-power-schema.ts`](../db/cycling-power-schema.ts). The forward
[ClickHouse migration](../db/clickhouse-migrations/0114_normalized_power_projection.ts)
replaces the activity-power view before removing the threshold-history view and
its old history storage.
Migration 0108 retains an isolated schema snapshot so historical upgrade tests
remain reproducible.

Activity eligibility uses the requested projection instant: an active
activity's recorded end must be at or before that instant. A future import
becomes dirty when it completes, including later on the same UTC day.
Clock-rewind fixtures verify that premature observations are tombstoned and
restored when eligible; see the [executable ClickHouse fixtures](cycling-power-projector.integration.test.ts).

The application adapter retains negative or nonfinite native watt observations
as timestamped null barriers. It preserves recorded zero watts; the reusable
numerical package continues rejecting invalid direct inputs. The integration
fixtures verify that invalid coverage produces unavailable normalized power
without failing the build.

[`run-analytics-build.ts`](../../scripts/run-analytics-build.ts) runs this stage
after successful dbt input builds and waits for all pending activity
observations before building the activity-power view and recording processing
success. Deletion and recomputation jobs await the same serialized analytics
writer via [`analytics-refresh-queue.ts`](../analytics-refresh-queue.ts).

`activity_fit_heart_rate` handles a bounded batch of activities per dbt run, so
the build repeats that model until a run writes no new rows
before the downstream models and the Sleep cache refresh.

[`activity-read-model-build.ts`](activity-read-model-build.ts) contains the CDC
barriers used before dispatching serialized analytics maintenance.

Observation writes use the existing account-erasure fence inside `INSERT …
SELECT`, and fenced accounts are excluded from dirty-source selection. The
[race fixture](cycling-power-projector.integration.test.ts) activates erasure
between source reads and the observation write.
