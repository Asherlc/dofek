# Task 7: repeated-effort discovery repository and MCP tool

Status: DONE_WITH_CONCERNS — Task 7 focused checks pass; existing Task 3 formatting and Task 6 server-typecheck failures remain for the controller.

## Implementation and review checkpoints

1. Read the exact Task 7 brief, README/server guidance, identity types/model, route matcher/model, benchmark schema, and existing MCP registration/test patterns. CodeGraph reported no usable index, so source inspection used repository files. No subagents, branch changes, HTTP servers, migrations, dependencies, or provider-specific branches were introduced.
2. RED: wrote public `RepeatedEffortsRepository.find` and in-memory MCP client tests before production modules; both suites failed on missing modules as the brief requested.
3. GREEN: implemented bounded typed queries, canonical grouping, identity/source evidence, strict output validation, and tool registration. Added real Postgres/ClickHouse tests with isolated minimal final-schema fixtures, not historical read-model migrations.
4. Self-review: added failing regressions for geometry mixing sports/modalities and conflicting identities from merged members. Fixed both, retaining conflict evidence and a quality flag. Database validation independently found and reproduced a UTC serialization defect; fixed query output to explicitly encode UTC.
5. Final focused validation: 101 unit/route tests and six integration tests pass. Eight changed TypeScript files pass Biome. Root typecheck passes. Package-specific typecheck and repository-wide lint expose unchanged earlier-task failures listed below.

## Contract

- `RepeatedEffortsRepository.find(input: FindRepeatedEffortsInput): Promise<FindRepeatedEffortsOutput>` takes the database, typed analytics query store, authenticated user, and analysis timezone in its constructor.
- Default `equivalenceStrength: strong`, `minimumRepetitions: 2`, `limit: 25`. Maximum page size 100 and minimum-repetition maximum 2,000; date, enum, array, number and cursor bounds are validated server-side.
- Exact groups use a lossless structured namespace/value key and preserve case-sensitive stable identifiers. Identity strengths occupy different groups. Activity instances are provenance, never reusable identity keys.
- Default discovery includes exact identities and strongly inferred geometry. Weak name candidates require `equivalence_strength: weak`; their keys additionally include type, modality and a five-minute observed-duration bucket. They always remain `weak_similarity`.
- Explicit `effort_kind: user_defined_benchmark` selects Level C assertions from Postgres; these remain `caller_asserted`, not exact. The default strong request excludes caller assertions. This interpretation preserves the brief's exact/strong-only default while permitting benchmark discovery.
- Canonical activities count once, with sorted canonical/member IDs, complete available source records, reusable identity evidence, provider/modality/type lists, first/last UTC occurrences, assumptions and quality flags. Same-namespace conflicting identities from merged members remain visible in returned identity evidence and are flagged.
- `expectedDurationSeconds` is null with `expected_duration_unavailable`: current identity projections do not supply prescribed protocol duration. Observed elapsed time is used only for explicitly selected weak candidates, never mislabeled as an expected duration.
- Route discovery consumes the existing bounded geometry model and matcher. All members must match each other and have the same activity type/modality. Partial/unavailable geometry is excluded. Match evidence preserves direction, overlap, endpoint/distance tolerances, elevation similarity, confidence and source geometry quality. Geometry capability is limited by upstream projection coverage (currently cycling); no cycling restriction is introduced in this repository.
- Every ClickHouse query uses authenticated-user filtering and `FINAL` plus live-row filtering. Canonical rows are date/provider/modality/type filtered, then evidence queries use the selected canonical/member UUIDs. Source reads select provenance columns only; no raw payload or sensor scan occurs.
- Discovery fails explicitly above 2,000 canonical candidates, 250 route candidates, or 20,000 rows per identity/source/benchmark projection. It tells callers to narrow dates/filters; it never silently truncates repetition counts. All selected candidates are grouped and filtered before result pagination.
- Versioned keyset cursors bind the authenticated user, timezone, dates and normalized filters. Page size may change between pages. Malformed or mismatched cursors fail.
- MCP `find_repeated_efforts` requires `activity:read`, advertises read-only annotations and strict output schema, uses the existing `{ result: ... }` structured-content envelope, and documents Level A/B/C/D plus the non-maximal/comparable-conditions caveat. Registry and route sentinel tests include the tool.

## RED/GREEN evidence

Initial RED command:

```text
rtk pnpm exec vitest run packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/mcp/repeated-efforts-tool.test.ts --project unit

Test Files 2 failed (2)
Cannot find module './repeated-efforts-repository.ts'
Cannot find module '/packages/server/src/mcp/repeated-efforts-output.ts'
```

Additional observed RED tests:

- Geometry across different modalities/sports: expected no group, received one three-activity `strong_inferred` group. Fix requires type/modality agreement before route matching.
- Conflicting merged-source identity: missing `conflicting_identity_evidence` flag. Fix flags conflicts and retains the conflicting identity observations alongside matching evidence.
- Real database timestamp test: expected `2026-01-01T08:00:00.000Z`, received `2026-01-01T16:00:00.000Z`. ClickHouse returned timezone-less UTC text, and the shared JavaScript timestamp parser interpreted it in the workstation timezone. Fix uses explicit UTC ISO query output; the fixture expectation was retained.

Final GREEN commands/output:

```text
rtk pnpm exec vitest run packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/mcp/repeated-efforts-tool.test.ts packages/server/src/mcp/route.test.ts --project unit

Test Files 3 passed (3)
Tests      101 passed (101)
Duration   3.47s

rtk proxy sh -c 'set -a; . ./.env.local; set +a; TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --project integration packages/server/src/repositories/repeated-efforts-repository.integration.test.ts'

Test Files 1 passed (1)
Tests      6 passed (6)
Duration   11.03s

rtk pnpm exec biome check packages/server/src/repositories/repeated-efforts-repository.ts packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/repositories/repeated-efforts-repository.integration.test.ts packages/server/src/mcp/repeated-efforts-output.ts packages/server/src/mcp/repeated-efforts-tool.ts packages/server/src/mcp/repeated-efforts-tool.test.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts

Checked 8 files in 162ms. No fixes applied.

rtk pnpm typecheck
TypeScript: No errors found

rtk git diff --check
No output; exit 0.
```

Integration coverage exercises identity/source/route SQL, Postgres benchmark membership, foreign-user isolation, current/tombstoned rows, invalid activity durations, date/provider/modality/type filtering before repetition counts, merged-provider evidence, weak opt-in, pagination, and cross-user cursor rejection. Existing healthy workspace database services were used directly, as in earlier task runs; no backing-service restart or incident remediation was performed. Vitest still emits the existing esbuild/oxc warning on unit runs.

## Files

- Create `packages/server/src/repositories/repeated-efforts-repository.ts`.
- Create `packages/server/src/repositories/repeated-efforts-repository.test.ts`.
- Create `packages/server/src/repositories/repeated-efforts-repository.integration.test.ts` (additional to the brief, to execute database semantics).
- Create `packages/server/src/mcp/repeated-efforts-output.ts`.
- Create `packages/server/src/mcp/repeated-efforts-tool.ts`.
- Create `packages/server/src/mcp/repeated-efforts-tool.test.ts`.
- Modify `packages/server/src/mcp/tools.ts` and `packages/server/src/mcp/route.test.ts`.
- Create this report.

## Self-review and concerns

- `rtk pnpm exec tsc --noEmit -p packages/server/tsconfig.json` fails in unchanged Task 6 code: `cycling-effort-metrics.ts(533,7): TS2532 Object is possibly 'undefined'`; `cycling-training-metrics-repository.ts(233,47): TS2304 Cannot find name 'bestPowerRowSchema'`. No new-file diagnostics. Root `pnpm typecheck` checks a different TypeScript scope and passes. `git diff HEAD --` confirms both failing files are unchanged by Task 7.
- `rtk pnpm lint:sandbox` stops at existing Biome formatting errors in `src/db/activity-effort-identity-read-model.integration.test.ts` and `src/db/activity-effort-identity-read-model.test.ts`, both unchanged by Task 7. Its later policy stages were not reached. No gates were disabled and no unrelated earlier-task files were changed.
- Request-scoped geometry group IDs use the deterministic candidate anchor and may change when the selected candidate set changes. They are not durable user benchmark IDs. The output states this limitation; Task 8 should not interpret them as persisted global route identity.
- Exact identity is evidence of the same referenced template/route/test, not proof of equivalent execution, maximal intent, conditions, or absence of contradictory member evidence. Consumers must inspect quality flags and assumptions.
- No UI change is part of this backend MCP task; both platforms can consume the same server result in future UI work. No client-side metric calculation was added.

## Retrospective

The test-first grouping fixtures and real-engine checks complemented each other: the database test caught the timezone defect that typed unit rows hid. Reusing existing identity and route interfaces kept provider logic out of discovery. Useful controller context is the distinction between prescribed and observed duration, explicit benchmark selection, candidate-scoped geometry IDs, and baseline failures outside root typecheck coverage.

Proposed documentation refinement for approval: add a server README note that ClickHouse timestamp queries used with JavaScript parsers must return explicit UTC offsets, and add package-specific `tsc -p packages/server/tsconfig.json` to the task validation checklist. No documentation policy changes were made during this task. Use TDD, integration-tests-ready and verification-before-completion for similar discovery repositories; no new skill is needed.

## Fix round 1 — route geometry provenance

Root cause: `RepeatedEffortsRepository` selected and validated the route geometry fields without `source_providers` or `source_devices`, then constructed every `route_geometry_v1` identity observation with `provider: null`; the route projection already provides the omitted fields.

The repository now selects and validates both route provenance arrays. Each geometry observation retains its own `sourceProviders` and `sourceDevices` plus the anchor's corresponding fields in evidence. `provider` is set when that observation has one geometry provider and remains null only when the projection has multiple providers, avoiding a fabricated singular attribution.

The executable regression uses a real isolated ClickHouse database. Its first canonical activity is merged from Garmin and Apple Health, while the route projection reports GPS only from Garmin/Edge 1050. It asserts the merged activity retains Garmin rather than Apple Health as the geometry source, every route member has provider/device evidence, and the anchor preserves its own provenance.

RED command/output:

```text
rtk proxy sh -c 'set -a; . ./.env.local; set +a; TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --project integration packages/server/src/repositories/repeated-efforts-repository.integration.test.ts'

Test Files 1 failed (1)
Tests      1 failed | 5 passed (6)
First fatal assertion: expected geometry evidence provider "garmin" with sourceProviders/sourceDevices, received provider null and no provenance arrays.
```

Final validation:

```text
rtk pnpm exec vitest run packages/server/src/repositories/repeated-efforts-repository.test.ts --project unit
Test Files 1 passed (1)
Tests      12 passed (12)

rtk proxy sh -c 'set -a; . ./.env.local; set +a; TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --project integration packages/server/src/repositories/repeated-efforts-repository.integration.test.ts'
Test Files 1 passed (1)
Tests      6 passed (6)

rtk pnpm exec biome check packages/server/src/repositories/repeated-efforts-repository.ts packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/repositories/repeated-efforts-repository.integration.test.ts
Checked 3 files. No fixes applied.

rtk git diff --check
No output; exit 0.

rtk pnpm typecheck
TypeScript: No errors found.
```

No Task 3 formatting or Task 6 package-typecheck files were changed. The earlier package-specific Task 6 diagnostics remain outside this fix round.

## Fix round 2 — undefined-safe route provenance access

Root cause: with `noUncheckedIndexedAccess`, the single-element `route.source_providers[0]` access remained typed as `string | undefined`, creating a new server-package typecheck error after the round-1 provenance fix. The access now uses `route.source_providers[0] ?? null`, preserving the existing rule that a singular route provider is reported and an unavailable value is represented as `null`.

Validation:

```text
rtk pnpm exec vitest run packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/mcp/repeated-efforts-tool.test.ts packages/server/src/mcp/route.test.ts --project unit
Test Files 3 passed (3)
Tests      101 passed (101)

rtk pnpm exec tsc --noEmit -p packages/server/tsconfig.json
Exit 2: unchanged Task 6 errors only:
  packages/server/src/repositories/cycling-effort-metrics.ts(533,7): TS2532
  packages/server/src/repositories/cycling-training-metrics-repository.ts(233,47): TS2304
```

The new `repeated-efforts-repository.ts(426,13)` diagnostic is resolved. No other files or behavior were changed for this round.
