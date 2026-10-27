# Task 7 report

Status: implemented and verified through review round 2. The original Task 7 commit is `99d157266`; review round 1 is `96d4282da2846eb7f86e8e7ad5a6830c899a0e5c` and is present on the configured upstream. Review round 2 commit/push evidence is recorded below.

Provider-absent fallback selection uses the complete representative order: complete quantitative working strength sets, total strength sets, distinct strength exercises, canonical-type specificity, provider-type refinement, provider/device priority, then member UUID.

## Files

- `packages/server/src/models/activity.ts`
- `packages/server/src/models/activity.test.ts`
- `packages/server/src/repositories/activity-repository.ts`
- `packages/server/src/repositories/activity-repository.test.ts`
- `packages/server/src/repositories/activity-repository.integration.test.ts`
- `packages/server/src/mcp/tool-output.ts`
- `packages/server/src/mcp/activity-details-tool.ts`
- `packages/server/src/mcp/route.test.ts`
- `packages/server/src/routers/activity.ts`
- `packages/server/src/routers/activity.test.ts`
- `packages/server/src/lib/activity-export-service.ts`
- `packages/server/src/repositories/clickhouse-activity-sensor-store.ts`
- `packages/server/src/repositories/clickhouse-activity-sensor-store.test.ts`
- `packages/server/src/repositories/clickhouse-activity-sensor-store-lifecycle.integration.test.ts`
- This report.

## Implementation

- Added one user-scoped PostgreSQL resolution query over current group IDs, raw member IDs, and merged historical aliases. It returns the requested ID, resolved stable group ID, and internal resolution kind. Current non-aliased groups have first precedence, then members, then aliases. A group row that is also a same-user alias is excluded from the direct-group branch so a retired merged identity cannot resolve to itself.
- Every resolution candidate is constrained by `user_id`. Cross-user groups, members, and aliases are indistinguishable from missing IDs and return `null` / NOT_FOUND without disclosing existence.
- The request-scoped repository memoizes the resolved lookup ID and its stable group ID. Downstream detail-family calls that receive the stable ID reuse the initial resolution instead of issuing a second identity query.
- Active detail, stream-window, HR-zone, power-zone, member-list, and provider-absent reads receive the resolved stable group ID. Resolution logs only requested ID, resolved group ID, and kind; no health payload is logged.
- ClickHouse summary and route-preview hydration now requests only `fitness.v_activity.id`, which is the stable group UUID. Removed `selectCompatibleActivitySummary`, its raw-member metadata query, and member-ID summary filtering. `filterToVisibleCanonicalActivities` now validates stable ClickHouse keys through `fitness.v_activity` rather than raw `fitness.activity.id`.
- Added optional domain `resolvedFrom` and MCP `resolved_from`. They are emitted only when requested and resolved IDs differ. Direct stable-group requests omit the field. MCP detail-family calls receive `activity.id`, the resolved stable group UUID.
- Updated the tRPC power-zone and strength-detail entry paths plus activity export stream hydration to pass the resolved group ID downstream rather than reusing the lookup input.
- Preserved Task 8 interfaces without adding a structured strength/climbing/finger-loading union or a representative/member compatibility fallback.
- Review round 1 made every activity-specific ClickHouse lookup singular and stable-group keyed. Stream points use `analytics.activity_stream_points`, heart-rate zones use `analytics.activity_heart_rate_zones`, and power zones use `analytics.activity_sensor_sample FINAL`; all three constrain both `user_id` and `activity_id = window.activityId`. Power retains the bounded activity timestamps but no longer scans time-only `analytics.deduped_sensor`.
- Missing, cross-user, or access-hidden IDs now raise the established `TRPCError` `{ code: "NOT_FOUND", message: "Activity not found" }` from repository stream/HR/power entry points. tRPC and MCP preserve that same message, so cross-user existence remains undisclosed.
- Fully provider-absent groups now exclude deleted rows and choose one request-independent metadata representative by specific canonical classification, normalized non-empty provider refinement, configured device/provider priority, then UUID. Group, member, and alias lookups therefore expose identical metadata with only `resolvedFrom`/`resolved_from` varying by the requested identity.

## RED evidence

### Unit and hydration

Command:

`rtk pnpm vitest run --project unit packages/server/src/models/activity.test.ts packages/server/src/repositories/activity-repository.test.ts --retry=0`

Result before production edits: 2 files failed, 6 tests failed, 64 passed, exit 1.

- Domain mapping failed with `expected undefined to be 'requested-member-id'`.
- Stable-summary hydration called ClickHouse with `[stable-group-id, representative-member-id, sensor-member-id]` instead of `[stable-group-id]`.
- The representative-invariance fixture produced `[[], [], []]` instead of the six populated stable-summary fields for each metadata variant, proving the compatibility selector discarded the group row when no raw member metadata matched its ID.
- The current repository executed only the implicit member-array detail query; the expected `identity_candidates` resolver did not exist.

### Real PostgreSQL

Command:

`rtk pnpm test:integration -- packages/server/src/repositories/activity-repository.integration.test.ts -t 'stable activity id resolution' --retry=0`

Result before production edits: 3 failed, 4 passed, 4 skipped, exit 1.

- A direct stable group ID returned `null`.
- A member ID returned the group row without `resolved_from`.
- A merged alias returned `null`.
- The cross-user group/member/alias and unknown-ID cases already returned `null`, establishing the non-disclosure baseline.

### MCP resolved downstream identity

Command:

`rtk pnpm vitest run --project unit packages/server/src/mcp/route.test.ts -t 'reports member-id substitution' --retry=0 --reporter=verbose`

The sandboxed attempt timed out because the local HTTP test server could not bind (`Server address is not an object`); no product conclusion was drawn from that prerequisite failure. The identical escalated command reached the assertion and failed because strength hydration received the requested member UUID instead of the stable group UUID.

### Resolve-once downstream reuse

Command:

`rtk pnpm vitest run --project unit packages/server/src/repositories/activity-repository.test.ts -t 'reuses one resolution when downstream hydration receives the stable group id' --retry=0`

Result before resolver memoization: 1 failed, 57 skipped, exit 1. The assertion was `expected 2 to be 1`, proving that `findById(member)` followed by stable-ID stream hydration executed the identity CTE twice.

### Review round 1: ClickHouse group-only reads

Command:

`rtk pnpm vitest run --project unit packages/server/src/repositories/clickhouse-activity-sensor-store.test.ts --retry=0`

Result before store changes: 3 failed, 20 passed, exit 1. Stream, HR zones, and power zones all supplied an `activityIds` array containing member IDs instead of singular `activityId`. Power SQL read `analytics.deduped_sensor` without an activity predicate.

Command:

`rtk pnpm test:integration -- packages/server/src/repositories/clickhouse-activity-sensor-store-lifecycle.integration.test.ts -t 'does not mix power samples' --retry=0`

Result before store changes: 1 failed, 5 skipped, exit 1. A target activity's real group-keyed power sample produced zone-1 seconds `0` instead of `1` because the query read the wrong model; the overlapping same-user activity fixture established the contamination boundary.

### Review round 1: sensor lookup errors

Command:

`rtk pnpm vitest run --project unit packages/server/src/repositories/activity-repository.test.ts -t 'throws NOT_FOUND without querying the sensor store' --retry=0`

Result before repository error changes: 3 failed, 57 skipped, exit 1. Stream resolved `[]`; HR and power resolved zero-filled zone arrays. All three were required to reject with identical NOT_FOUND errors after user-scoped resolution.

### Review round 1: provider-absent determinism

Command:

`rtk pnpm test:integration -- packages/server/src/repositories/activity-repository.integration.test.ts -t 'selects the same deterministic' --retry=0`

Result before fallback ranking: 1 failed, 11 skipped, exit 1. Direct group and alias requests selected the deleted lowest UUID, while the two member requests selected themselves, producing four request-dependent results.

Command:

`rtk pnpm vitest run --project unit packages/server/src/repositories/activity-repository.test.ts -t 'falls back to provider-absent' --retry=0`

Result before fallback ranking: 1 failed, 59 skipped, exit 1; first mismatch was `expected ... to contain 'a.deleted_at IS NULL'`.

### Review round 1: stale router fixtures

The previously reported 126-test command was green, but review found that two HR tests supplied a sensor-window row where the new resolver row belonged. The router test's intentionally schema-free database stub let those malformed responses pass through without proving the resolved window. Both fixtures now supply resolver then window rows, and both assert the exact stable-group window passed to the sensor store. Two analogous stream fixtures were corrected in the same audit. This was a test-harness correction, not a production behavior change, so no product RED result is claimed for it.

## GREEN and verification

- `rtk pnpm vitest run --project unit packages/server/src/models/activity.test.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/routers/activity.test.ts --retry=0`: exact formerly 126-test command, now 3 files and 130 tests passed after adding four error-contract cases.
- `rtk pnpm vitest run --project unit packages/server/src/models/activity.test.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/clickhouse-activity-sensor-store.test.ts packages/server/src/routers/activity.test.ts --retry=0`: 4 files, 153 tests passed.
- Escalated `rtk pnpm vitest run --project unit packages/server/src/mcp/route.test.ts --retry=0`: 1 file, 67 tests passed.
- Escalated `rtk pnpm test:integration -- packages/server/src/repositories/activity-repository.integration.test.ts packages/server/src/repositories/clickhouse-activity-sensor-store-lifecycle.integration.test.ts --retry=0`: 2 files, 20 tests passed against real PostgreSQL and ClickHouse.
- `rtk pnpm exec biome check` over all 8 review-round TypeScript files: passed.
- `rtk pnpm typecheck`: `TypeScript: No errors found`.
- `rtk git diff --check`: passed.

The integration-test readiness setup used the workspace Compose wrapper. Its first sandboxed `compose:env` attempt stopped at `listen EPERM .../tsx-502/...pipe`; the identical escalated command generated ports and confirmed PostgreSQL, ClickHouse, Redis, and Redpanda healthy. A direct Vitest integration invocation then correctly reported that `.env.local` does not provide `TEST_DATABASE_URL`; using the canonical `pnpm test:integration` wrapper supplied it and ran the real PostgreSQL suite.

## Schema decision

The PostgreSQL resolution result has three internal fields: `requested_id`, `resolved_group_id`, and `resolution_kind` (`group | member | alias`). These do not expand the external raw-row schema. Repository output adds optional nullable `resolved_from` only after a successful differing-ID resolution. The domain model maps that to optional `resolvedFrom`; MCP keeps the established snake-case style as optional nullable `resolved_from`. Direct group requests omit both external fields rather than mislabeling them as substitutions.

## Rollout and compatibility

Deploy after the stable PostgreSQL group/alias schema and stable group-keyed ClickHouse read models from Tasks 2-6. There is deliberately no fallback to representative/member summary rows: ClickHouse must have the stable group summary. Existing current group IDs, raw member bookmarks, and retired merged IDs resolve through the same user-scoped path; substituted responses make the redirect observable.

Structured detail calls now receive stable group IDs. Their source-aware multi-member union implementation remains Task 8; Task 7 does not add an interim member fallback or compatibility layer.

One unchanged broader integration fixture remains outside this task: `activity-visibility-consistency.integration.test.ts` aborts in setup with `Active activity is missing persisted group identity` because the shared ClickHouse integration helper's raw `activity` sync column list omits `group_id`. The Task 7 repository integration file passes completely. The parent ledgered this shared-harness parity fix for Task 10; no timeout, fallback, or out-of-scope harness change was added here.

## Retrospective

What went well: the real PostgreSQL fixture made direct group, member, alias, cross-user, and missing behavior explicit, while the group-only summary fixture reproduced the exact representative-dependent field loss. What required investigation: retired group rows coexist with alias rows, so the direct-group candidate must exclude retired aliases; otherwise precedence would incorrectly resolve a merged ID to itself. Useful next-time context: ClickHouse integration fixtures must mirror `activity.group_id` whenever stable-group models are rebuilt.

Review round 1 showed that repository-level canonicalization is incomplete unless every downstream store method also uses the stable key. Exact query-parameter tests caught member fan-out, while the executable overlapping-window fixture caught the more serious time-only power contamination. It also showed why schema-bypassing test database doubles must provide each query's true row shape and assert the downstream boundary object; otherwise stale resolver mocks can pass while exercising impossible data.

Suggested guidance: add a shared ClickHouse-test-harness checklist item requiring every PostgreSQL mirror column used by a dbt identity invariant to appear in `rawTableSyncs`. Continue using `integration-tests-ready`, strict TDD, systematic debugging, and verification-before-completion for cross-store identity changes.

## Review fix round 2/5 — provider-absent relational payload rank

Status: implemented, verified, and committed as `201427136e26b3967af7e6661448b0d6e17b7f95` (`Rank absent activities by strength payload`). The required automatic `rtk git push` was attempted after commit but the approval reviewer rejected private-code egress because the configured remote's trust was not established from trusted user content. The branch is one commit ahead of `origin/fix/activity-representative-selection`; parent escalation is required to complete the push.

### Files and implementation

- `packages/server/src/repositories/activity-repository.ts`
- `packages/server/src/repositories/activity-repository.test.ts`
- `packages/server/src/repositories/activity-repository.integration.test.ts`
- This report.

The provider-absent fallback now applies the same PostgreSQL relational strength tuple as `drizzle/0111_v_activity_stable_groups.sql` before the existing metadata tuple: complete working-set count descending, total set count descending, and distinct exercise count descending. A working set is complete only when at least one of `weight_kg`, `reps`, `duration_seconds`, or `distance_meters` is non-null; numeric zero remains valid because completeness is null-based. Classification specificity, normalized provider-type refinement, device/provider priority, and UUID remain the lower tie-breaks. The aggregate is a correlated lateral query over `fitness.strength_set` for the candidate member; no test-only export, raw sensor read, or ClickHouse fallback was introduced.

Parent ruling resolved a wording discrepancy in the reviewer request: the actual canonical view ranks `complete_working_set_count, set_count, exercise_count`. Task 7 mirrors that implemented contract exactly and does not invent a populated-quantitative-field rank that would conflict with the canonical projection.

The real PostgreSQL fixture makes the metadata-only winner superior on both type/refinement and effective device priority. It has two all-null working sets across two exercises, so it has more total sets and exercises but zero complete working sets. The lower-quality generic member has one working set whose only quantitative values are `weight_kg = 0` and `reps = 0`, proving zero-valued observations count as complete and complete-set count outranks every lower field. Requests by the stable group, every member including the deleted candidate, and the alias all return the same payload-bearing member metadata. Only substituted identities expose `resolved_from`; the direct group does not.

### Strict RED evidence

- `rtk pnpm vitest run --project unit packages/server/src/repositories/activity-repository.test.ts --retry=0`
  - Exit 1; 1 failed, 59 passed. First product assertion: `expected ... to contain "s.set_type = 'working'"`, proving the fallback query had no relational payload aggregate.
- The first sandboxed integration wrapper attempt stopped before product execution at `Error: listen EPERM: operation not permitted .../tsx-502/55670.pipe`; it was rerun with the required IPC/Compose permission and is not counted as behavioral RED.
- Escalated `rtk pnpm test:integration -- packages/server/src/repositories/activity-repository.integration.test.ts -t 'selects the same deterministic non-deleted fallback' --retry=0`
  - Exit 1; 1 failed, 13 skipped. Every one of the six lookup forms returned metadata-only `Preferred absent ride` instead of the expected zero-valued complete-set member `Generic absent activity`.

### GREEN and final verification

- `rtk pnpm vitest run --project unit packages/server/src/repositories/activity-repository.test.ts --retry=0`: exit 0; 1 file, 60 tests passed.
- Escalated `rtk pnpm test:integration -- packages/server/src/repositories/activity-repository.integration.test.ts -t 'selects the same deterministic non-deleted fallback' --retry=0`: exit 0; 1 passed, 13 skipped. Reran after adding the deleted member to the lookup matrix with the same result.
- `rtk pnpm vitest run --project unit packages/server/src/models/activity.test.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/clickhouse-activity-sensor-store.test.ts packages/server/src/routers/activity.test.ts --retry=0`: exit 0; 4 files, 153 tests passed.
- Escalated `rtk pnpm vitest run --project unit packages/server/src/mcp/route.test.ts --retry=0`: exit 0; 1 file, 67 tests passed.
- Escalated `rtk pnpm test:integration -- packages/server/src/repositories/activity-repository.integration.test.ts packages/server/src/repositories/clickhouse-activity-sensor-store-lifecycle.integration.test.ts --retry=0`: exit 0; 2 files, 20 tests passed against real PostgreSQL and ClickHouse. The final post-edit run is recorded with commit evidence below.
- `rtk pnpm typecheck`: exit 0; `TypeScript: No errors found`.
- `rtk pnpm exec biome check packages/server/src/repositories/activity-repository.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/repositories/activity-repository.integration.test.ts`: exit 0; 3 files checked, no fixes applied.
- `rtk git diff --check`: exit 0.

### Schema, rollout, compatibility, and concerns

No external schema changed. `resolved_from` remains optional and appears only when requested and resolved IDs differ. Rollout order remains unchanged: deploy after the stable PostgreSQL membership/alias schema and canonical view; provider-absent selection uses only relational PostgreSQL state and never consults sensor richness. There is no representative/member compatibility fallback. The Task 10 shared ClickHouse fixture concern recorded above remains unchanged and outside this fix.

### Retrospective

The executable PostgreSQL fixture made the tuple boundary concrete: all-null working rows increase set/exercise counts but do not outrank a zero-valued complete working set. The main investigation was reconciling mistaken review prose with the checked-in canonical SQL; an explicit parent ruling avoided creating a second rank contract. Useful future guidance: reviewer briefs that cite a canonical migration should quote its exact ordered SQL fields, and payload-rank regression fixtures should include both zero-valued complete rows and all-null incomplete rows. Reuse `superpowers:test-driven-development`, `integration-tests-ready`, and `superpowers:verification-before-completion` for similar persistence fixes; no new skill is needed.
