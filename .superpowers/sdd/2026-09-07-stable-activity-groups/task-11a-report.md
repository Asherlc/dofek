# Task 11A report

Status: review fix round 1 is implemented, verified, committed, and pushed. The
production/test/documentation commit is
`e2878d523c557755212868f33d7629b4874d9b6e` on
`fix/activity-representative-selection`. The original Task 11A commits remain
`8d8fa2d8f` and `cfced18ef`.

## Root cause

The original defect was in `activity_stream_points.restored_dirty_keys`: every
active group whose latest stream state was tombstoned was selected again without
requiring a newer activity lifecycle event. The first fix added the intended
`deduped_activities.refresh_version > stream_refresh_version` predicate.

The review regression then reran the actual production dependency slice in dbt
order: real `deduped_activities`, followed by `activity_stream_points`. It proved
the first fix was incomplete because `deduped_activities` generated a new
wall-clock `refresh_version` for every active group on every incremental build,
even when all inputs and output content were unchanged. The causal predicate was
therefore true again and the downstream payload-free group appended another
tombstone.

## Upstream watermark audit

Every input/version that can affect `deduped_activities` was inspected:

- `activity_source_records` supplies active membership, `group_id`, provider and
  device `priority`, representative/display fields, `raw`, `source_synced_at`,
  and absence-adjacent source links. Its `refresh_version` and `refreshed_at`
  are model-run wall clocks and change on unchanged rebuilds.
  `source_synced_at` is the activity CDC `_peerdb_synced_at`; it does not capture
  provider/device-priority changes.
- `deduped_sensor` supplies `source_activity_id`, active/deleted state, sample
  counts, and altitude presence used by representative ranking. Its
  `refresh_version` is a processed-batch clock and is not stable across every
  unchanged producer replay; its source timestamp does not cover
  priority-driven attribution changes.
- `postgres_fitness.activity` supplies provider-absent membership and link data,
  including `id`, `group_id`, `provider_id`, `external_id`,
  `provider_absent_at`, `raw`, `source_name`, `deleted_at`,
  `_peerdb_is_deleted`, and `_peerdb_version`. No single version from this input
  spans active relational content, ranking evidence, sensor evidence, and
  absence transitions.

There is therefore no existing single upstream version that is both stable on
unchanged input and complete for every output-relevant transition. Adding a
stored source-of-truth column or content hash was unnecessary: the current group
row can be compared directly with the latest target state.

## Durable lifecycle fix

On incremental builds, `deduped_activities` now compares the full current served
row with the latest `ReplacingMergeTree` target state. The comparison covers:

- identity and winner: `primary_activity_id`, `provider_id`;
- ranking/display data: `canonical_type`, `provider_type`, `modality`,
  `started_at`, `ended_at`, `source_name`, `name`, `notes`, `timezone`, both UTC
  offsets, `local_time_source`, and `raw`;
- source state: `source_synced_at`, `source_providers`,
  `source_external_ids`, `absent_source_external_ids`, and
  `member_activity_ids`.

Nullable scalars use null-safe equality. The three aggregate arrays are emitted
in deterministic sorted order so equal logical state compares equal. A
target-equivalent active row is suppressed entirely: it retains both its prior
lifecycle version and physical row count. A new, changed, or restored row gets
`greatest(previous_refresh_version + 1, current_clock_version)`, which is both
strictly newer than its prior active/tombstoned state and compatible with the
shared nanosecond version domain. A disappearance tombstones only a previously
active row and uses the same monotonic rule, so an existing tombstone is not
re-emitted. Full refreshes still emit the complete current state.

This preserves append incremental and `ReplacingMergeTree` ordering without a
duplicate stored source of truth. Scoped builds use the same comparison and
suppression inside their affected-group set; unscoped builds compare all current
groups. The downstream stream model retains its causal restoration predicate.

## Strong RED evidence

Command, before the durable producer fix:

`rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts -t "unchanged production dependency slice" --retry=0'`

Result: 1 failed, 2 filtered by the focused `-t` selection, duration 8.41
seconds. The behavioral assertion expected the existing stream version
`1788852259818446200` but received `1788852261946733907`. Its diagnostic also
showed that the unchanged real `deduped_activities` producer advanced its
version, establishing the producer wall clock as the cause of repeated
downstream tombstone churn. The test did not manually freeze or edit the
upstream refresh version.

The earlier Task 1 deferred audit also produced a focused unit RED:

`rtk pnpm vitest run --project unit src/domain/activity-grouping.test.ts src/domain/activity-representative.test.ts --retry=0`

Before replacing `localeCompare`: 2 files failed, 2 tests failed, and 20 tests
passed. Under intentionally reversed ambient collation, both public algorithms
selected UUID `...00b` instead of code-unit-lower UUID `...00a` for both input
permutations.

## GREEN and verification evidence

- The expanded focused production-slice command passed: 1 passed and 2 tests
  were skipped only because `-t` filters the independent sensor-microbatch and
  route-reconciliation scenarios; duration 23.55 seconds. It proves unchanged
  unscoped and scoped builds retain the deduped activity version, deduped raw row
  count, deduped unique-transition count, stream version, and stream
  unique-transition count. It also executes provider-priority winner change,
  sensor-rich winner change, membership remap/stream dirtiness, true
  delete/restore with retained location payload, and unrelated-group
  preservation.
- Full real-ClickHouse dependency fixture:
  `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts --retry=0'`:
  1 file, 3 tests passed in 61.69 seconds.
- Affected real-ClickHouse representative suite:
  `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/deduped-activities-read-model.integration.test.ts --retry=0'`:
  1 file, 17 tests passed in 13.26 seconds.
- Affected unit/property/static suite:
  `rtk pnpm vitest run --project unit src/domain/activity-grouping.test.ts src/domain/activity-representative.test.ts analytics/models/read_models/read_model_microbatch.sql.test.ts --retry=0`:
  3 files, 60 tests passed. Vitest printed the existing Oxc/esbuild
  configuration warning.
- `rtk pnpm typecheck`: `TypeScript: No errors found`.
- Targeted Biome over the affected TypeScript files: 7 files checked, no fixes
  required.
- Targeted SQLFluff/dbt lint of
  `analytics/models/read_models/deduped_activities.sql`: exit 0 after dbt node
  sorting; no violations.
- `rtk git diff --check`: clean before commit.
- `rtk git push`: `cfced18ef..e2878d523` pushed to
  `origin/fix/activity-representative-selection`.

The first focused rerun in the restricted sandbox failed before behavior because
the process could not connect to the workspace ClickHouse endpoint (`EPERM`).
The same command was rerun with the required local-container permission and
passed; no product or test-harness workaround was added.

## Deferred audit decisions

### Task 1 UUID tie-breaks

Changed with evidence in `8d8fa2d8f`. Default-locale `localeCompare` did not
encode the explicit code-unit ordering required by the UUID tie-break contract.
The focused permutation regressions prove the public grouping and representative
results no longer depend on ambient collation. The shared production
`compareCodeUnits` helper uses JavaScript relational string comparison.

### Task 4 provider-type normalization coverage

Test-only improvement in `8d8fa2d8f`. The prior blank/whitespace/case variants
ran on the already higher-priority member, so the expected result did not force
the normalization decision. Swapping provider priorities makes an incorrect
refinement bit change the result; correct production ranking was unchanged.

### Task 7 report summary

Documentation-only correction in `8d8fa2d8f`. The opening now records every
provider-absent rank key: complete quantitative working strength sets, total
strength sets, distinct strength exercises, canonical specificity, provider
refinement, provider/device priority, and UUID.

## Self-review

- The lifecycle version is content-causal: it advances only for a real served
  state transition and is strictly monotonic across active/tombstoned states.
- Unchanged incremental groups emit zero physical rows, preventing target bloat
  as well as logical downstream churn. Full refresh semantics are unchanged.
- True restoration, provider and sensor ranking changes, membership remaps,
  scoped idempotence, and unrelated groups execute through real dbt models and
  real ClickHouse.
- The change adds no schema column, stored hash, retry, sleep, heuristic, feature
  flag, retention change, or client-side behavior.

## Retrospective and feedback loop

What went well: rerunning the real producer/consumer slice exposed that a causal
consumer predicate is only as sound as the producer watermark. Comparing current
served state to the latest target state made the lifecycle contract directly
executable and eliminated both logical and physical churn.

What required investigation: the three upstream sources expose several clocks,
but none covers all membership, display, ranking, sensor, and absence transitions
without also changing on unrelated rebuild mechanics. Array aggregation order
also had to become deterministic before direct row equality was trustworthy.

Useful context next time: every append-incremental lifecycle model should rerun
its real upstream dependency slice unchanged and assert both logical transition
count and physical row count. Consumer restoration tests alone cannot prove the
upstream watermark is stable.

Suggested guidance for approval: add to `analytics/AGENTS.md` that a lifecycle
watermark must be stable across unchanged producer rebuilds, advance on every
served-content transition, and have a real dependency-slice test that checks raw
row count as well as latest state.

Recommended skills for similar work: `systematic-debugging`,
`test-driven-development`, `integration-tests-ready`, and
`verification-before-completion`.
