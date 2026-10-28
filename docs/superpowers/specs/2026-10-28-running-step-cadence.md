# Running cadence from raw HealthKit step intervals

The user explicitly chose importing underlying step intervals rather than using
Apple's workout step aggregate. Extend the existing raw running ingestion plan
with this source; do not introduce aggregate fallback or synthetic cadence in
canonical storage.

## Native source and synchronization

Collect only step quantities explicitly associated with running HealthKit
workouts, using Apple's [workout association predicate](https://developer.apple.com/documentation/healthkit/hkquery/predicateforobjects(from:)-5irg9)
and [quantity series descriptor](https://developer.apple.com/documentation/healthkit/hkquantityseriessamplequerydescriptor).
Transport each real quantity with its parent sample UUID, exact interval,
sourceName/sourceBundle, and original associated workout UUIDs. Merge repeated
associations into one child observation; do not duplicate a raw child per workout.
No step rate, total, or duration average is calculated on the client.

Provide a range snapshot for normal/full workout sync and a two-phase anchored
step delta for updates and parent deletions. Snapshot again on workout and step
observer deliveries to recover step-first/workout-later associations. Delta
queries discover running workouts for added step parents, including historical
changes, and always return deleted UUIDs. Extract all data before registering a
pending anchor; acknowledge only after workout/sample uploads and deletions
succeed. Honor the existing device erasure cutoff. Do not introduce all-day raw
step ingestion or change the existing daily-statistics writer.

## Canonical ingestion

Use a dedicated `pushRunningStepSamples` mutation. Its original running workout
records are additive evidence: upsert them without reconciling a partial list as
provider absence. Keep confirmed presence and user deletion rules intact. A
small shared workout-upsert function may be extracted from the current full
workout sync, which retains its existing reconciliation.

A raw child is stored once in the existing metric stream with channel
`step_count`, scalar equal to the source count, and metadata retaining interval
end, source bundle, and original workout UUID associations. Keep parent
`hk:<UUID>` external identity for tombstones. Child row identity must distinguish
parent, source/provider/user, interval start and end, and generation. Preserve
raw count and intervals; never store a fabricated cadence observation.

Reject negative/nonfinite counts, non-count units, intervals with zero or negative duration, missing
workout association, and non-running or foreign workout contexts with actionable
errors. Publisher failures must propagate and report to Sentry. A deleted step
parent tombstones only its raw step children; normal daily StepCount uploads
continue down the daily-statistics path.

## Analytics and serving

Add one bounded, activity-grain `activity_step_cadence_rows` dbt model. Resolve
raw associations through current user-owned activity source records and canonical
membership. Read latest raw versions including tombstones, keep step intervals
out of point-timestamp sensor deduplication, and retain raw source identity.

Use only intervals wholly contained in the associated run. Count a raw child
once per canonical group, and exclude ambiguous children associated with distinct
canonical groups. Select one valid recording source per activity, respecting
existing cadence source priorities and stable coverage/source tie breaks. Never
combine overlapping sources; same-source overlaps invalidate that source rather
than double-counting or prorating observations. Reject zero-duration and invalid
counts in analytics too, because retained raw data may predate validation.

For the selected disjoint intervals, calculate:

`cadence = 60 * sum(raw step counts) / sum(observed interval seconds)`.

Retain observed interval seconds and sample/source evidence in the read model.
This is a rate over recorded intervals, not a claim of pause-excluded cadence
throughout the workout. Missing or ambiguous observations remain unavailable.
Additions, parent corrections/deletions, source changes, group changes, removals,
and restored activities must recompute affected rows or emit tombstones within
the existing bounded incremental lifecycle. No request-time raw stream scan or
historical full refresh is permitted; use [dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models).

Prefer positive direct sensor cadence when present; otherwise use this computed
interval cadence in the existing shared activity summary so web and mobile
receive the same server value. Wire the new model into production model selection
and processing contracts. Resolve the running form's ground-contact display from
existing ground-contact/stance-time channels, and accept unnamed source runs
without rejecting the query. Empty-state copy must name absent cadence/imported
interval evidence rather than promise another recording will fix it.

## Verification and release boundary

Test raw extraction and identity, snapshot/delta ordering, late association,
historical updates/deletions, source overlap, invalid intervals, canonical group
ownership, direct-cadence precedence, and incremental deletion/recovery with
executable ClickHouse fixtures. Keep the API/XML running measurement tests and
existing daily totals behavior passing. Run native coverage, affected package
typechecks, full unit/mobile tests, full lint, and the relevant integration tier.
A native release, authorization, and historical sync remain necessary to acquire
previously omitted on-device observations; do not claim production recovery from
code-only validation.

## Protocol details

Native bridge methods are `queryRunningStepSamples(startDate, endDate)` and
`queryRunningStepChanges(initialStartDate)`. The former returns the range
snapshot; the latter returns the snapshot shape plus `deletedUUIDs` and `queryId`.
Use the existing StepCount identifier for two-phase anchor completion. Newly
added parents discover all matching running workout associations before their
anchor can be acknowledged; deletion-only deltas must still reach the server.
The ordinary workout/step observer snapshot remains necessary for associations
that arrive after the step parent itself.

A source workout association is an array on the new step DTO, not a fabricated
HealthKit type or a calculated field on the ordinary quantity upload. Merge
associations before publication. Persist only this associated subset of raw step
observations; existing daily totals cover a different, complete-day source scope.
The server must not call full-list absence reconciliation for partial workout
contexts. Restore confirmed provider presence through the existing guarded
presence helper without clearing manual user deletions.

Use the existing deterministic metric event factory's generation handling. If it
needs interval identity, extend its generic handling for `metadata.interval_end`
so differing interval ends are distinct while existing point event identities
remain unchanged. Preserve the parent external ID for all step child tombstones.

## Cadence basis and client parity

Materialize cadence basis and observed coverage alongside `avg_cadence` in the
same activity summary row, so a partially refreshed pipeline cannot label an
older numeric value with newer source evidence. Use `cadence_basis` values
`cadence_samples`, `step_intervals`, or `unknown`, plus nullable
`cadence_observed_seconds` and `cadence_coverage_percent`. For step intervals,
coverage is `100 * observed seconds / activity wall-clock seconds`, rounded
server-side for display; direct cadence may retain unknown coverage. Schema
changes use a forward-only ClickHouse migration; tests create the current final
schema directly rather than replay historical backfills.

Expose this evidence with running rows as `cadenceBasis`,
`cadenceObservedSeconds`, and `cadenceCoveragePercent`. The web cadence tooltip
and running-form cadence cell must distinguish rates from recorded steps and
show known coverage without repeating explanatory paragraphs. Add the equivalent
running cadence/form card to the mobile training screen, using existing chart
and unit-formatting components and the same server response. Clients render
these values without deriving rates or coverage. Preserve specific server
errors and visible previous data during refetches; keep optional missing form
metrics unavailable rather than zero.

Test normal recorded cadence, interval-derived cadence with partial coverage,
missing optional form metrics, loading/refetch, errors, empty results, and the
mobile query's saved date range. Give new UI components colocated tests and
stories; mobile route helpers/tests/stories remain outside app/. Inspect the
changed web/mobile stories with browser tooling. Any HTTP preview server must
have the required Paseo quick tunnel for its lifetime, and shared Storybook
links must point to the specific story.

Running form must not disappear solely because cadence or speed is missing.
`dynamicsV2.data` includes a run when any cadence, stride, contact-time, or
oscillation measurement is available. Preserve nullable `cadence`,
`paceSecondsPerKm`, and `distanceKm` rather than coercing missing evidence to
zero. Its existing `availability` describes form rows; add server-authored
`cadenceAvailability` counting usable cadence rows for the cadence chart.
Both clients use this distinction, render missing cells as unavailable, and
retain other form measurements when the cadence chart is empty. Existing v1
running query consumers/types must remain coherent with the final contract;
do not add a temporary compatibility route or fabricate missing numbers.

The anchored StepCount discovery query must page through at most 500 added or
deleted parents per request. It discovers all-day parent changes before selecting
associated running observations, so an unbounded first All-history query would
retain unrelated years of step objects. Return required `hasMore: boolean`, true
when the underlying added-plus-deleted parent count reaches 500. The client
uploads/deletes and acknowledges each successful page, then continues while
`hasMore` is true, even when that page has no running observations. Failure on a
later page preserves the last successfully committed cursor. Keep this limit
local to the new raw-step delta path; do not change generic quantity queries.

Zero-count intervals are real observations and remain in the duration
denominator. A valid observed interval rate of zero remains numeric zero;
absence or rejected evidence remains null. Test the all-zero case separately
from no observations, as well as mixed zero/nonzero intervals. Direct sensor
cadence keeps its existing positive-sample preference.
