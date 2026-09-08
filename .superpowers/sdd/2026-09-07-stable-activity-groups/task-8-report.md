# Task 8 report

Status: implemented and verified. Commit and push evidence is recorded after the final verification run.

## Files

- `packages/server/src/repositories/strength-repository.ts`
- `packages/server/src/repositories/strength-repository.test.ts`
- `packages/server/src/repositories/strength-repository.integration.test.ts`
- `packages/server/src/repositories/climbing-repository.ts`
- `packages/server/src/repositories/climbing-repository.test.ts`
- `packages/server/src/routers/activity.test.ts`
- `packages/server/src/mcp/route.test.ts`
- This report.

`packages/server/src/routers/activity.ts` and `packages/server/src/mcp/activity-details-tool.ts` already passed the Task 7 resolved `activity.id` to structured repositories. They required no duplicate production edit; the new router and MCP tests pin their stable-group behavior with a non-representative Strong member and non-empty structured output.

## Implementation

- Strength detail hydration accepts the already-resolved stable group UUID, selects that exact `fitness.v_activity.id`, and joins every current member in `member_activity_ids`. It no longer treats a member UUID as a compatible lookup fallback.
- Every strength query row retains `member_activity_id`, `member_provider_id`, and effective configured source priority. Device priority wins when the member source name matches a configured device pattern; provider priority is next; the existing default of `100` is last. Provenance remains repository-internal and does not expand the public API.
- Exercise identity is the normalized tuple `(trimmed/collapsed/lowercased exercise name, trimmed/collapsed/lowercased equipment)`, never `exercise_index`. Returned exercises are sorted by that identity and assigned deterministic sequential indexes, preventing React key collisions while retaining each set's provider-supplied sequential index.
- Set identity is exactly `(setType, setIndex, weightKg, reps, durationSeconds)`. Null and numeric zero remain distinct. Exact mirrors collapse; any tuple difference remains visible. Rest rows retain their `rest` type and zero-duration values.
- For equivalent detail rows, completeness is the count of populated consumer-visible annotations (`rpe`, nonblank `notes`). Higher completeness wins before lower configured source priority, then member UUID provides the deterministic final tie-break. Exercise metadata independently prefers populated muscle groups/type before the same source ordering.
- All strength aggregate consumers now use one SQL-ranked, source-aware deduplicated set relation before computing weekly volume/counts, estimated max, muscle-group volume, progressive overload, or workout summaries. Its exact identity tuple matches detail hydration; completeness additionally considers stored distance and exercise metadata because those fields feed aggregate consumers. The PostgreSQL regression proves a mirrored working set contributes once.
- `ClimbingRepository.getActivityEntries` now selects the exact stable `a.id` while still joining all current climbing entries through `member_activity_ids`.

## Strict RED evidence

### Unit mapping and climbing lookup

Command:

`rtk pnpm vitest run --project unit packages/server/src/repositories/strength-repository.test.ts packages/server/src/repositories/climbing-repository.test.ts --retry=0`

Result before production edits: exit 1; 3 failed, 61 passed.

- Two members whose distinct exercises both used `exercise_index=0` returned only `Deadlift`; `Bench Press` was collapsed.
- Two pairs of exact mirrored sets returned five rows instead of three, proving no signature dedupe or completeness/source selection existed.
- Climbing entry SQL lacked `a.id =` and still compared the lookup ID with `ANY(a.member_activity_ids)`.

### Real PostgreSQL group union

The first sandboxed wrapper attempt stopped before product execution with `Error: listen EPERM: operation not permitted .../tsx-502/78709.pipe`. It was rerun with the required local IPC/Compose permission and is not counted as behavioral RED.

Command:

`rtk pnpm test:integration -- packages/server/src/repositories/strength-repository.integration.test.ts -t 'unions member sets' --retry=0`

Result before production edits: exit 1; 1 failed, 2 skipped. A stable group containing a non-representative Strong member and a richer mirror returned only `Task 8 Deadlift`; the expected `Task 8 Bench Press` member payload was missing because provider-local index zero collapsed both exercises.

## GREEN and verification

- `rtk pnpm vitest run --project unit packages/server/src/repositories/strength-repository.test.ts packages/server/src/repositories/climbing-repository.test.ts --retry=0`: exit 0; 64 tests passed.
- `rtk pnpm test:integration -- packages/server/src/repositories/strength-repository.integration.test.ts -t 'unions member sets' --retry=0`: exit 0; 1 passed, 2 skipped.
- `rtk pnpm vitest run --project unit packages/server/src/routers/activity.test.ts --retry=0`: exit 0; 57 tests passed.
- Escalated `rtk pnpm vitest run --project unit packages/server/src/mcp/route.test.ts -t 'reports member-id substitution' --retry=0`: exit 0; 1 passed, 66 skipped. The final renamed test is included in the full MCP run below.
- `rtk pnpm vitest run --project unit packages/server/src/repositories/strength-repository.test.ts packages/server/src/repositories/climbing-repository.test.ts packages/server/src/repositories/climbing-training-log-repository.test.ts packages/server/src/routers/activity.test.ts --retry=0`: exit 0; 4 files, 124 tests passed.
- Escalated `rtk pnpm vitest run --project unit packages/server/src/mcp/route.test.ts --retry=0`: exit 0; 67 tests passed.
- Escalated `rtk pnpm test:integration -- packages/server/src/repositories/strength-repository.integration.test.ts --retry=0`: exit 0; 3 tests passed. The new fixture resolves direct group, both member UUIDs, and a merge alias to byte-for-byte equivalent structured exercises. It also proves the mirrored workout adds exactly 3 working sets, 1 workout, and 1,330 kg rather than 4 sets and 1,830 kg.
- `rtk pnpm typecheck`: exit 0; `TypeScript: No errors found`.
- Final Biome and `git diff --check` evidence is recorded with the commit below.

## Cross-repository audit

- Confirmed and fixed: `ClimbingRepository.getActivityEntries` had a member-compatible input predicate. It now requires the resolved stable group ID and hydrates entries from all members.
- Confirmed canonical already: `readFingerLoadingActivity` selects `fitness.v_activity.id` and joins every `finger_loading_entry` through `member_activity_ids`.
- No ID migration needed: `ClimbingTrainingLogRepository.getFingerLoadingHistory` and `readFingerLoadingRange` are time/range queries, not single-activity resolution entry points.
- Router and MCP structured paths already use the stable `activity.id` from Task 7 for strength, climbing, and finger loading. Focused tests now require non-empty output after a non-representative Strong member lookup.

## Compatibility, rollout, and concerns

No database schema or public response field changed. `exerciseIndex` remains an integer but now represents deterministic union order rather than an unsafe provider-local index, so grouped exercises have unique sequential client keys. Set indexes, typed rest sets, and valid zero values remain unchanged.

Deploy after the Task 7 stable membership/alias and `fitness.v_activity` changes. There is no compatibility fallback: callers must resolve group/member/alias identity once and pass the returned group ID. No Strong parser or machine metadata behavior was changed; that remains Task 9.

The aggregate dedupe uses PostgreSQL window ranking across selected strength ranges. Existing finite range predicates remain in place; all-history requests intentionally scan all visible strength sets as before, with extra ranking work. No new cache, index, schema, or speculative optimization was added without evidence.

## Retrospective

What went well: the same two-member PostgreSQL fixture proved stable resolution, normalized exercise union, exact mirror removal, rest/zero preservation, and aggregate volume correctness. What required investigation: `v_activity.member_activity_ids` and the configured device/provider priority order had to be traced so detail and aggregate selection used the established source contract rather than inventing another one. Useful next-time context: the approved design should explicitly define which non-signature fields count toward completeness and whether returned union indexes are public source indexes or presentation indexes.

Suggested guidance update for approval: add that exact completeness definition and the deterministic sequential union-index contract to `packages/server/README.md`; add an `AGENTS.md` reminder that structured single-activity repositories accept only resolved group IDs after Task 7. Reuse `superpowers:test-driven-development`, `integration-tests-ready`, and `superpowers:verification-before-completion` for similar cross-member hydration changes; no new skill is needed.
