# Task 8 report

Status: implemented, verified, committed as `e044f36`, and pushed to `origin/fix/activity-representative-selection`.

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
- All strength aggregate consumers now use one SQL-ranked, source-aware deduplicated set relation before computing weekly volume/counts, estimated max, muscle-group volume, progressive overload, or workout summaries. Its exact identity tuple matches detail hydration; set-row completeness considers stored annotations and distance, while exercise metadata is enriched independently. The PostgreSQL regression proves a mirrored working set contributes once.
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
- `rtk pnpm exec biome check packages/server/src/repositories/strength-repository.ts packages/server/src/repositories/strength-repository.test.ts packages/server/src/repositories/strength-repository.integration.test.ts packages/server/src/repositories/climbing-repository.ts packages/server/src/repositories/climbing-repository.test.ts packages/server/src/routers/activity.test.ts packages/server/src/mcp/route.test.ts`: exit 0; 7 files checked, no fixes applied.
- `rtk git diff --check`: exit 0.
- `rtk git commit -m "Union structured activity details across members"`: exit 0; commit `e044f36`.
- `rtk git push`: exit 0; `201427136..e044f36e8` pushed to `origin/fix/activity-representative-selection`.

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

## Review fix round 1

Status: the three review findings were fixed and verified in implementation commit `41f8e8a`.

### Files

- `packages/server/src/routers/climbing.ts`
- `packages/server/src/routers/climbing.test.ts`
- `packages/server/src/repositories/strength-repository.ts`
- `packages/server/src/repositories/strength-repository.test.ts`
- `packages/server/src/repositories/strength-repository.integration.test.ts`
- `packages/server/src/repositories/progressive-overload.ts`
- `packages/server/src/repositories/progressive-overload.test.ts`
- `packages/server/src/contracts/progressive-overload.ts`
- `packages/server/src/routers/strength.ts`
- `packages/server/src/routers/strength-stress.test.ts`
- `packages/server/src/services/mobile-training-tab.test.ts`
- This report.

### Fixes and compatibility

- The climbing `activityEntries` router now resolves every requested group, current member, or merge alias through `ActivityRepository.findById` in the authenticated user's visibility/access scope. It passes only the returned stable `activity.id` to `ClimbingRepository`. Missing and cross-user UUIDs produce the same actionable `NOT_FOUND: Activity not found` response and never call the structured repository.
- Estimated-max and progressive-overload series now carry the public strength exercise identity `{ exerciseName, equipment }`. Raw rows project nullable equipment, repository grouping uses nested name/equipment maps rather than encoded composite strings, and output sorts by name then equipment. Same-name BARBELL and DUMBBELL observations remain separate through domain and router output.
- Aggregate set ownership now ranks exact-signature mirrors solely by set-row completeness (`rpe`, nonblank notes, stored distance), configured source priority, then member UUID. Separate deterministic metadata relations select the preferred display identity, best nonempty muscle groups, and best nonblank exercise type by configured source priority/member UUID, then enrich the one winning set row. Metadata can no longer decide ownership of an equivalent set or disappear when richer annotations come from another mirror.
- The set signature remains exactly `(setType, setIndex, weightKg, reps, durationSeconds)`. No schema, ingestion, Strong parser, or machine-metadata behavior changed. The response-contract change is additive: `equipment: string | null` is now present on e1RM and progressive-overload rows. Consumers that ignore unknown fields remain compatible; typed consumers receive the proper identity dimension.

### Strict RED evidence

Command:

`rtk pnpm vitest run --project unit packages/server/src/routers/climbing.test.ts packages/server/src/repositories/strength-repository.test.ts --retry=0`

Result before production edits: exit 1; 6 failed, 49 passed. Stable/member/alias router cases recorded zero `ActivityRepository.findById` calls, unresolved IDs incorrectly resolved to `[]`, and BARBELL/DUMBBELL histories collapsed into one same-name e1RM/overload result without equipment.

The first sandboxed PostgreSQL wrapper attempt stopped before product execution with `Error: listen EPERM: operation not permitted .../tsx-502/27425.pipe`. The permitted rerun reached PostgreSQL:

`rtk pnpm test:integration -- packages/server/src/repositories/strength-repository.integration.test.ts -t 'split exercise metadata' --retry=0`

Result before production edits: exit 1; 1 failed, 3 skipped. The exact mirrored set added 100 kg once, but the shoulder set delta was `0` instead of `1`, proving the annotation-rich owner discarded independently available muscle metadata.

The expanded real-database GREEN run also caught and drove two SQL corrections before final verification: positional `GROUP BY 2` referred to the newly inserted equipment aggregate, and the e1RM `best_per_workout` CTE did not initially project equipment. Both were corrected directly; the final suite below exercises both queries.

### GREEN and final verification

- `rtk pnpm vitest run --project unit packages/server/src/routers/climbing.test.ts packages/server/src/repositories/strength-repository.test.ts packages/server/src/repositories/progressive-overload.test.ts packages/server/src/routers/strength-stress.test.ts packages/server/src/services/mobile-training-tab.test.ts --retry=0`: exit 0; 5 files, 97 tests passed.
- Escalated `rtk pnpm test:integration -- packages/server/src/repositories/strength-repository.integration.test.ts --retry=0`: exit 0; 5 real-PostgreSQL tests passed. The split fixture proves a 100 kg mirror contributes exactly once while its independently selected shoulder metadata contributes one set; another fixture proves BARBELL/DUMBBELL same-name e1RM and overload histories remain distinct and deterministically ordered.
- `rtk pnpm typecheck`: exit 0; `TypeScript: No errors found`.
- `rtk pnpm exec biome check packages/server/src/contracts/progressive-overload.ts packages/server/src/repositories/progressive-overload.test.ts packages/server/src/repositories/progressive-overload.ts packages/server/src/repositories/strength-repository.integration.test.ts packages/server/src/repositories/strength-repository.test.ts packages/server/src/repositories/strength-repository.ts packages/server/src/routers/climbing.test.ts packages/server/src/routers/climbing.ts packages/server/src/routers/strength-stress.test.ts packages/server/src/routers/strength.ts packages/server/src/services/mobile-training-tab.test.ts`: exit 0; 11 files checked, no fixes applied.
- `rtk git diff --check`: exit 0.

### Broader checks and concerns

- Escalated `rtk pnpm test:changed`: 206 of 207 files passed and 5,573 of 5,599 tests passed. The only failing file was the untouched `packages/server/src/repositories/activities-calendar-repository.test.ts` (26 failures); its first assertion received no activity at line 218 because its queued DB mocks do not account for earlier stable-ID visibility queries. This is outside the three approved findings and was not changed.
- Sandboxed `rtk pnpm lint` first stopped at tsx IPC with `listen EPERM`. The escalated rerun passed exact-version checks, Biome over 3,230 files, suppression/workflow/migration/mobile/story/review/route policies, then failed in untouched analytics SQL with pre-existing SQLFluff `ST03` unused-CTE findings. The first was `analytics/models/read_models/activity_location_sample.sql:17` for `target_state`; no Task 8 file failed lint.

### Retrospective

What went well: focused unit RED isolated the public identity loss and router bypass, while the real PostgreSQL fixture demonstrated metadata loss without confusing it with set inflation. What required investigation: projecting an added identity field through every SQL CTE and positional group clause needed real execution; the database suite caught both omissions immediately. Useful next-time context: aggregate queries should document set ownership and metadata ownership as separate provenance decisions.

Suggested guidance update for approval: document in `packages/server/README.md` that structured analytics output identities include equipment and that aggregate mirror selection must enrich exercise metadata independently of set ownership. For similar fixes, reuse `superpowers:test-driven-development`, `integration-tests-ready`, and `superpowers:verification-before-completion`; no new skill is needed.

## Review fix round 2

Status: both remaining review findings were fixed and verified in implementation commit `059afc26031975b1b7636c318917aee9945a0b84`.

### Files

- `packages/training/src/training.ts`
- `packages/server/src/repositories/progressive-overload.ts`
- `packages/server/src/repositories/strength-repository.ts`
- `packages/server/src/routers/strength.ts`
- `packages/server/src/routers/strength-stress.test.ts`
- `packages/server/src/routers/mobile-dashboard.ts`
- `packages/server/src/routers/mobile-dashboard.test.ts`
- `packages/server/src/routers/climbing.ts`
- `packages/server/src/routers/climbing.test.ts`
- `packages/web/src/components/EstimatedMaxChart.tsx`
- `packages/web/src/components/EstimatedMaxChart.test.tsx`
- `packages/web/src/components/EstimatedMaxChart.stories.tsx`
- `packages/web/src/components/ProgressiveOverloadCards.tsx`
- `packages/web/src/components/ProgressiveOverloadCards.test.tsx`
- `packages/web/src/components/ProgressiveOverloadCards.stories.tsx`
- `packages/mobile/components/ProgressiveOverloadCards.tsx`
- `packages/mobile/components/ProgressiveOverloadCards.test.tsx`
- `packages/mobile/components/ProgressiveOverloadCards.stories.tsx`
- `packages/mobile/app-tests/(tabs)/strain.test.tsx`
- This report.

### Client identity and cache rollout

- The canonical public strength-series identity is now shared from `@dofek/training/training` as the structured tuple `{ exerciseName, equipment }`. Selection compares both fields, while list keys serialize the tuple as JSON; no delimiter-concatenated identifier is used, so provider text cannot create delimiter collisions.
- Web estimated-max selection now retains the full tuple. Same-name BARBELL and DUMBBELL buttons independently select their matching series, have distinct React keys and `aria-label` values, and expose the selected state correctly.
- Web and mobile progressive-overload cards now key by the same tuple. Equipment is appended to visible labels only when the returned collection contains an ambiguous exercise name, preserving ordinary single-equipment labels. Mobile accessible summaries use the same disambiguated label; web's visible text remains accessible DOM content.
- Server repository types import the same shared identity model, removing a server-local duplicate definition without changing the round-1 response fields.
- Runtime cache namespaces were advanced for every strict payload affected by the two review rounds: `estimated-max-trend-v2`, `progressive-overload-evidence-v2`, and mobile `training-activity-states-v3`. The climbing activity-entry route now uses `climbing-activity-group-v1`, preventing an old silently empty member/alias result from surviving the resolved-group deployment.
- Cache assertions were folded into successful resolver behavior tests that also validate returned payloads. No static-config-only test was added; generic cache-key isolation remains covered by the existing tRPC cache middleware tests.

### Strict RED evidence

Command before production edits:

`rtk pnpm vitest run --project unit --project mobile packages/web/src/components/EstimatedMaxChart.test.tsx packages/web/src/components/ProgressiveOverloadCards.test.tsx packages/mobile/components/ProgressiveOverloadCards.test.tsx packages/server/src/routers/strength-stress.test.ts packages/server/src/routers/mobile-dashboard.test.ts packages/server/src/routers/climbing.test.ts --retry=0`

Result: exit 1; 6 files failed, 7 tests failed and 69 passed. Estimated-max rendered duplicate `Chart Chest Press` controls, both variants appeared selected, React reported a duplicate key, and clicking could not select the dumbbell series. Web and mobile overload cards rendered duplicate `Chest Press` labels and duplicate keys, while mobile accessible labels also collided. Route behavior still registered `estimated-max-trend-v1`, `progressive-overload-evidence-v1`, mobile `training-activity-states-v2`, and an unversioned climbing long-cache entry.

### GREEN and final verification

- `rtk pnpm vitest run --project unit --project mobile packages/training/src/training.test.ts packages/web/src/components/EstimatedMaxChart.test.tsx packages/web/src/components/ProgressiveOverloadCards.test.tsx packages/mobile/components/ProgressiveOverloadCards.test.tsx packages/server/src/routers/strength-stress.test.ts packages/server/src/routers/mobile-dashboard.test.ts packages/server/src/routers/climbing.test.ts --retry=0`: exit 0; 7 files, 153 tests passed. The component run emitted no duplicate-key warnings.
- `rtk pnpm typecheck`: exit 0; `TypeScript: No errors found`.
- `rtk pnpm exec biome check 'packages/mobile/app-tests/(tabs)/strain.test.tsx' packages/mobile/components/ProgressiveOverloadCards.stories.tsx packages/mobile/components/ProgressiveOverloadCards.test.tsx packages/mobile/components/ProgressiveOverloadCards.tsx packages/server/src/repositories/progressive-overload.ts packages/server/src/repositories/strength-repository.ts packages/server/src/routers/climbing.test.ts packages/server/src/routers/climbing.ts packages/server/src/routers/mobile-dashboard.test.ts packages/server/src/routers/mobile-dashboard.ts packages/server/src/routers/strength-stress.test.ts packages/server/src/routers/strength.ts packages/training/src/training.ts packages/web/src/components/EstimatedMaxChart.stories.tsx packages/web/src/components/EstimatedMaxChart.test.tsx packages/web/src/components/EstimatedMaxChart.tsx packages/web/src/components/ProgressiveOverloadCards.stories.tsx packages/web/src/components/ProgressiveOverloadCards.test.tsx packages/web/src/components/ProgressiveOverloadCards.tsx`: exit 0; 19 files checked, no fixes applied.
- `rtk git diff --check`: exit 0.

This round changes only client identity rendering/selection and cache namespaces; it does not modify SQL or database semantics, so no new real-PostgreSQL test was required. The round-1 database suite remains the executable proof for the payload identity and union behavior feeding these clients.

### Compatibility, rollout, and concerns

There is no new response-contract change in this round. Web and mobile now consume the additive `equipment` field introduced in round 1. The cache namespace changes intentionally make pre-deploy strength, mobile-training, and climbing values unreachable after rollout; normal cache warming repopulates the new namespaces. No schema migration, parser change, compatibility fallback, or Task 9 metadata work was added.

No Task 8 concern remains. The prior broad-suite failures recorded in round 1 are outside these two findings; this focused review round did not expand into those parked issues.

### Retrospective

What went well: one same-name/different-equipment fixture reproduced selection, React-key, visible-label, and accessibility failures on both platforms, and behavior-level router tests pinned every deploy boundary. What required investigation: cache versions were distributed across strength, mobile-dashboard, and climbing routers rather than tied to the shared response type. Useful next-time context: when a public domain identity gains a dimension, the design checklist should enumerate client selection state, list keys, labels, accessibility text, and persistent-cache consumers together.

Suggested guidance update for approval: add that identity-and-cache-consumer checklist to `packages/training/README.md` and the stable activity group rollout notes. Reuse `superpowers:receiving-code-review`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion` for similar cross-platform contract reviews; no new skill is needed.
