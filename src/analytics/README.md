# Application analytics orchestration

[`cycling-power-projector.ts`](cycling-power-projector.ts) persists derived
cycling power history using the reusable
[`@dofek/cycling-power` algorithms](../../packages/cycling-power/README.md).
Application reference data and policy live in
[`cycling-power-policy.ts`](cycling-power-policy.ts); persistence is defined by
[`cycling-power-schema.ts`](../db/cycling-power-schema.ts).

The projector first refreshes normalized power for at most 100 changed completed
activities with power, including cycling activities whose power is unavailable.
It then reconstructs at most 32 ready users' compact cycling histories. Each user
is published only after all their normalized-power observations match current
source versions. Corrections, deletion tombstones, algorithm versions, policy
versions, and UTC date progression participate in invalidation; see the
[projector](cycling-power-projector.ts) and its
[executable ClickHouse fixtures](cycling-power-projector.integration.test.ts).

Activity eligibility uses the requested projection instant: an active activity's
recorded end must be at or before that instant. A future import becomes dirty
when it completes, including later on the same UTC day. Clock-rewind fixtures
verify that premature observations are tombstoned and restored when eligible;
see the [maturity regressions](cycling-power-projector.integration.test.ts).

The application adapter retains negative or nonfinite native watt observations
as timestamped null barriers. It preserves recorded zero watts; the reusable
numerical package continues rejecting invalid direct inputs. The
[negative-sentinel regression](cycling-power-projector.integration.test.ts)
verifies that invalid coverage produces unavailable NP without failing the build.

[`run-analytics-build.ts`](../../scripts/run-analytics-build.ts) runs this stage
after successful dbt input builds, then builds threshold-dependent healthspan
models before recording the combined processing result.
Outstanding projection work prevents processing success and cache warming.
Deletion and recomputation jobs await the same serialized analytics writer via
[`analytics-refresh-queue.ts`](../analytics-refresh-queue.ts).

[`activity-read-model-build.ts`](activity-read-model-build.ts) contains the CDC
barriers used before dispatching serialized analytics maintenance.

Both observation and history writes use the existing account-erasure fence inside
`INSERT … SELECT`, and fenced accounts are excluded from dirty-user selection.
The [race fixtures](cycling-power-projector.integration.test.ts) activate erasure
between source reads and each persistence boundary.
