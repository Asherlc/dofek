# Task 11A report

Status: implemented, verified, committed, and pushed. The production/test/deferred-audit commit is `8d8fa2d8f` on `fix/activity-representative-selection`.

## Root cause and fix

`activity_stream_points.restored_dirty_keys` selected every currently active group whose latest stream row was a tombstone. It did not require a newer activity lifecycle event, so an active group with no sensor or location payload was selected on every ordinary incremental build and received a new wall-clock tombstone each time.

Both sides of the intended comparison are materialization lifecycle clocks. `deduped_activities.refresh_version` and `activity_stream_points.refresh_version` are generated with `toUInt64(toUnixTimestamp64Nano(now64(9)))`. `current_activity` now carries the upstream activity lifecycle version, and restoration is dirty only when `current_activity.refresh_version > existing_stream_state.stream_refresh_version`.

The executable fixture now derives delete and restore lifecycle versions from the latest stream version instead of using unrelated small integers. This proves true restoration is causally newer than the tombstone. The payload-free fixture begins with activity lifecycle version 2 and stream tombstone version 1, so the first model run produces the required tombstone transition and the unchanged second run must preserve both its latest version and unique logical-transition count. Existing group remap, scoped member/prior-group repair, and unrelated-group version assertions remain in the same real-ClickHouse scenario.

## RED evidence

Command:

`rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts -t "preserves unrelated routes" --retry=0'`

Before the production edit: 1 test failed and the companion test was skipped by the `-t` filter. The first behavioral failure was:

`AssertionError: expected '1788850515811624597' to be '1788850513695829762'`

at `src/db/activity-payload-dbt-microbatch.integration.test.ts:440`. The unchanged second build advanced the tombstone-only group's latest stream version, directly reproducing the churn.

The Task 1 deferred audit also produced a focused unit RED:

`rtk pnpm vitest run --project unit src/domain/activity-grouping.test.ts src/domain/activity-representative.test.ts --retry=0`

Before replacing `localeCompare`: 2 files failed, 2 tests failed, and 20 tests passed. Under an intentionally reversed ambient collation, both public algorithms selected UUID `...00b` instead of the code-unit-lower UUID `...00a` for both input permutations.

## GREEN and verification evidence

- The same focused real-ClickHouse lifecycle command passed: 1 passed, 1 skipped only because `-t` filtered the independent sensor test; duration 28.85 seconds.
- `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm vitest run --project integration src/db/activity-payload-dbt-microbatch.integration.test.ts --retry=0'`: 1 file, 2 tests passed in 39.85 seconds against the workspace ClickHouse 26.8.2.7 service.
- `rtk pnpm vitest run --project unit src/domain/activity-grouping.test.ts src/domain/activity-representative.test.ts analytics/models/read_models/read_model_microbatch.sql.test.ts --retry=0`: 3 files, 60 tests passed. Vitest printed the existing Oxc/esbuild configuration warning.
- `rtk pnpm test:integration -- packages/server/src/routers/activity-dedup.integration.test.ts -t "normalizes an unrefined provider type" --retry=0`: 1 file, 3 cases passed and 25 unrelated tests were filtered.
- `rtk pnpm typecheck`: `TypeScript: No errors found`.
- Targeted `rtk pnpm biome check` over the seven changed TypeScript files: 7 files checked, no fixes required.
- Canonical targeted SQLFluff compiled the dbt project and reported only the three existing Task 6 alternate-Jinja-branch ST03 findings for `target_state`, `current_activity`, and `existing_stream_points`. It reported no additional rule or changed-line finding. A diagnostic retry excluding ST03 triggered SQLFluff's existing LT08 `list index out of range` exception and branch-rendering layout noise, so it was not treated as a clean lint substitute and no suppression or configuration change was made.
- `rtk git diff --check`: clean before commit and after the implementation commit.
- `rtk git push`: `4eb87e97b..8d8fa2d8f` pushed to `origin/fix/activity-representative-selection`.

The first direct PostgreSQL Vitest attempt failed before behavior with `TEST_DATABASE_URL is required for integration tests`; rerunning through the repository's `pnpm test:integration` wrapper supplied the generated database URL and passed unchanged. No product or harness change was made for that prerequisite failure.

## Deferred audit decisions

### Task 1 UUID tie-breaks

Changed with evidence. The Task 1 algorithms receive UUID identifiers, while default-locale `localeCompare` is language-sensitive and does not state the explicit code-unit ordering required by the deterministic tie-break contract. The two focused permutation regressions prove the public grouping and representative results no longer depend on ambient collation. A single production `compareCodeUnits` helper now uses JavaScript's relational string comparison, and every Task 1 identifier ordering call uses it.

### Task 4 provider-type normalization coverage

Test-only improvement. The old blank/whitespace/case variants ran on the already higher-priority member, so the expected winner did not independently force normalization. The test now gives that member worse provider priority and expects the other member to win. An incorrect refinement bit now changes the result; correct production ranking was not modified.

### Task 7 report summary

Documentation-only correction. The opening now records all provider-absent rank keys: complete quantitative working strength sets, total strength sets, distinct strength exercises, canonical specificity, provider refinement, provider/device priority, and UUID.

## Self-review

- The production lifecycle change is one upstream column plus one causal predicate; it adds no retry, sleep, time heuristic, feature flag, retention change, schema migration, or client-side behavior.
- True delete/restore, payload-free idempotence, scoped remaps, member/prior-group lookup, and unrelated groups execute in real ClickHouse.
- The comparator is shared rather than duplicated, and the tests assert public algorithm outcomes instead of the helper or a mock call.
- The provider normalization audit changes only the mutation sensitivity of an existing integration test.

## Retrospective and feedback loop

What went well: extending the existing delete/restore transition kept every lifecycle invariant executable in one current-schema ClickHouse fixture. Deriving lifecycle versions from the target row made the causal contract explicit and removed the fixture's old incomparable clocks.

What required investigation: Task 6's harmless-one-recomputation ruling became indefinite churn for tombstone-only groups, and the deferred Task 1/Task 4 concerns required tests that could distinguish the intended decision from an already winning rank key.

Useful context next time: a tombstone restoration branch needs both current lifecycle state and a monotonic source-versus-target version comparison; an unchanged second build should be a standard assertion for append-incremental lifecycle models.

Suggested guidance for approval: add to `analytics/AGENTS.md` that tombstone restoration must require a causally newer source lifecycle watermark and that transition fixtures must rerun unchanged once. Add to `docs/testing.md` that direct `vitest --project integration` requires an already exported `TEST_DATABASE_URL`, while `pnpm test:integration` provisions it.

Recommended skills for similar work: `systematic-debugging`, `test-driven-development`, `integration-tests-ready`, and `verification-before-completion`.
