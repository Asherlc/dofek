# Climbing context implementation plan

Status: approved for Native execution on 2026-09-30.

Execute tasks in dependency order. Each task has a failing-test cycle and a
review checkpoint; complete its checks before committing and pushing its
named files. Review the complete change before release.

**Goal:** Preserve and show full climbing locations, board, wall angle,
climbing method, and recorded result from Kaya, Mountain Project, and OpenBeta
on web and mobile.

**Architecture:** Store structured source facts on `fitness.climbing_entry`.
The permanent `fitness.v_climbing_entry` view derives the existing scalar read
contract. Both clients receive a provider-scoped context object and share
display formatting.

**Tech stack:** Existing TypeScript, Zod, Drizzle, PostgreSQL, Vitest/MSW,
React, React Native, and Storybook; no new third-party dependencies.

**Spec:** [Approved climbing context design](../specs/2026-09-29-climbing-context-design.md).

## Global constraints

- Location nodes are ordered broadest to nearest; IDs and roles may be null.
- Kaya angles retain `unit: null` until units and orientation are verified.
- Known degree angles remain within −90 to 90; unknown-unit values are finite.
- Store `location_path`, `board`, `wall_angle`, `climb_style`, and `result_style`
  once. Replace stored `location_name`, `wall_angle_degrees`, `lead`, and `sent`.
- A method alone never establishes a send. Preserve unfamiliar result labels,
  including Frenchfree, with an unknown interpreted outcome.
- Preserve raw payloads and provider identities; deduplicate only when reading.
- Missing totals remain null. An export row or Fell/Hung is not one attempt,
  and Fell/Hung does not identify an individual failure reason.
- Providers continue existing authentication, pagination, absence, attachment,
  and grade policies. Mountain Project uses its CSV export without enrichment.
- Use synthetic personal records in tests and public documentation. Cite the
  provider evidence in the approved spec and the linked provider audits.
- Work on the current branch. Preserve unrelated changes and any active merge;
  never finish someone else's merge or include their files in these commits.
- Release requires separate approval for the documented maintenance cutover.

## Review focus

1. Legacy entries must retain IDs, attachments, absence state, raw data, and
   detailed attempts through migration — Task 3, `preserves legacy identities`.
2. Missing or misaligned OpenBeta hierarchy arrays must not attach an ID to
   the wrong place or overwrite good records — Task 3, `rejects mismatched paths`.
3. A deduplicated entry must retain the selected metadata provider's namespace
   — Task 4, `retains preferred context provider`.
4. A top-rope method, Frenchfree, or an unfamiliar result must not imply a send;
   Fell/Hung must not invent counts — Tasks 3 and 5, `preserves independent results`.
5. Unknown units, negative values, and a known zero-degree angle must display
   accurately; only known degrees reach degree analytics — Tasks 1, 3, and 5.

## File boundaries and interfaces

| Files | Responsibility |
| --- | --- |
| `packages/training/src/climbing-context.ts` | Canonical Zod schemas and inferred types shared by ingestion, SQL boundaries, and API consumers. |
| `packages/format/src/climbing-context.ts` | Location, method, result, and angle labels; no metric computation. |
| `packages/kaya-client/src/client.ts` | Observed Kaya GraphQL selection and validated transport records. |
| `src/db/schema/activity.ts`, `drizzle/0135_climbing_context.sql` | Canonical columns, atomic legacy conversion, constraints, and read projection. Recheck the migration number before creating it. |
| `src/providers/kaya-sync.ts`, `src/providers/kaya/import.ts`, `src/providers/mountain-project.ts`, `src/providers/openbeta.ts` | Provider-specific parsing and base-table writes. |
| `packages/server/src/repositories/climbing-repository.ts`, `climbing-entry-associator.ts` | Activity details, summaries, suggestions, and selected-source metadata. |
| `packages/server/src/repositories/climbing-progression-repository.ts`, `performance-comparison-repository.ts`, `analytical-training-load-repository.ts` | Existing analytics read the permanent projection. |
| `packages/server/src/contracts/climbing-context-contracts.ts`, `packages/server/src/routers/climbing.ts`, `packages/server/src/mcp/tool-output.ts`, `packages/server/src/mcp/climbing-sessions-tool.ts` | Validate and expose the expanded read contract. |
| Web/mobile `ClimbingEntryContext.tsx` | One context renderer per platform, reused in attached and unattached displays. |
| `docs/climbing-context.md` | Canonical fields, interpretation, conversion, and maintenance release instructions. |

Task 3 includes all writers and existing scalar readers because removing the
stored columns makes those changes inseparable. Task 4 then adds structured
metadata to the API without changing the established association contract.

### Task 1: Shared context contract and labels

**Files:** Create `packages/training/src/climbing-context.ts` and its colocated
test; create `packages/format/src/climbing-context.ts` and its colocated test.
Modify `packages/format/src/format.ts` and its test,
`packages/format/package.json`, `pnpm-lock.yaml`, `packages/format/README.md`,
and `packages/training/README.md`. Register the format subpath and add the
existing workspace package `@dofek/training` as a dependency.

**Interfaces:** Export `ClimbingLocationNode`, `ClimbingBoard`, `ClimbingWallAngle`,
`ClimbingStyle`, `ClimbingMetadata`, and `ClimbingContext`, inferred from exported
Zod schemas. `ClimbingMetadata` has `locationPath`, `board`, `wallAngle`,
`climbStyle`, and `resultStyle`; `ClimbingContext` also has `providerId: string`.
Copy node/object shapes and method values exactly from the spec. Export
`climbingMetadataSchema` and `climbingContextSchema` for production boundaries.

- [x] Add `validates source context`: accept an empty path and null metadata;
  accept a six-node path with null IDs; reject blank names/IDs, invalid roles,
  non-finite values, malformed objects, and known degrees outside [−90, 90].
- [x] Add `formats independent context`: assert `TR`'s normalized method renders
  `Top rope`, `Fell/Hung` renders `Fell or hung`, Frenchfree remains recorded,
  missing result renders `Result unknown`, and `{ value: -20, unit: null }`
  renders `Wall angle: −20 (units unknown)`. Zero degrees renders
  `Wall angle: 0°`. Full paths retain every node.
- [x] Run `pnpm test --run packages/training/src/climbing-context.test.ts packages/format/src/climbing-context.test.ts`;
  expect failure because the new modules are absent.
- [x] Implement strict context schemas and the formatting signatures:
  `formatClimbingLocationPath(nodes: readonly ClimbingLocationNode[]): string | null`,
  `formatClimbingStyle(style: ClimbingStyle | null): string | null`,
  `formatClimbingResultStyle(result: string | null): string`, and
  `formatClimbingWallAngle(angle: ClimbingWallAngle | null): string | null`.
  Use ` > ` between location names. Keep provider-label normalization in each
  provider. Clients import domain types using type-only imports.
- [x] Test then update `formatClimbingAttemptResult(null, null)` to explicitly
  say `Outcome and attempt count not recorded`; keep its other branches.
- [x] Run the new tests plus `packages/format/src/format.test.ts`; expect PASS.
  Review raw shapes and formatting boundaries, then commit and push only the
  Task 1 files with `Add shared climbing context types and labels`.

### Task 2: Request Kaya's verified climb metadata

**Files:** Modify `packages/kaya-client/src/client.ts`, its test, and
`docs/kaya-api.openapi.yaml`.

**Interfaces:** Keep `KayaClient.listSessions(userId): Promise<KayaSession[]>`
and `listAscents(userId): Promise<KayaAscent[]>`. Extend the shared climb record
with nullable `{ id: string, name: string }` references `destination`, `area`,
`subarea`, and `board`, plus `angle: number | null` validated as an integer.
Use those exact upstream keys; existing gym fields remain available.

- [x] Add `retains context on both climb feeds`: assert synthetic ascents and
  attempted climbs retain all three outdoor references, a board, and angle
  −20; assert null metadata survives and page two retains the same fields.
  Verify both emitted queries request the five fields. Update old fixtures
  with explicit nulls for selected fields.
- [x] Run `pnpm test --run packages/kaya-client/src/client.test.ts`; expect the
  new assertions to fail because the parser drops fields and queries omit them.
- [x] Extend the climb schema and both query selections; require nullable keys
  according to the requested response shape. Keep the complete transport
  records for raw provenance. Update the observed API specification with the
  [Kaya evidence](../../kaya.md#observed-location-and-angle-values).
- [x] Run the client tests and `pnpm lint:openapi`; expect PASS. Review that
  null and zero are distinct and no degree unit is assumed.
- [x] Commit and push the Task 2 files with `Request Kaya location board and angle`.

### Task 3: Convert canonical storage and every import/read path

**Files:** Modify `src/db/schema/activity.ts`; create
`drizzle/0135_climbing_context.sql`; register it in `drizzle/meta/_journal.json`.
Create `src/db/climbing-context-migration.integration.test.ts`.
Modify the four provider files from the file map and their existing unit tests.
Modify the five repositories from the file map to read `fitness.v_climbing_entry`;
association updates continue writing the base table.

**Database tests:** Extend `src/providers/mountain-project-sync.integration.test.ts`,
`src/providers/openbeta-sync.integration.test.ts`, and
`packages/server/src/repositories/kaya-sync.integration.test.ts`.
Adapt current-schema fixtures in `src/db/unattached-climbing-entry.integration.test.ts`,
`src/db/climbing-attempt-count-backfill.integration.test.ts`, and server
climbing/association/progression/performance/training-load/router integration tests.
Preserve legacy fixture shapes in tests of historical migrations.

**Interfaces:** `climbingEntry` exposes `locationPath: ClimbingLocationNode[]`,
`board: ClimbingBoard | null`, `wallAngle: ClimbingWallAngle | null`,
`climbStyle: ClimbingStyle | null`, and `resultStyle: string | null`.
`attemptCount` is nullable with no default of one. The view exposes every base
column plus derived `location_name`, `lead`, `sent`, `wall_angle_degrees`, and
`ascent_type`; existing repository public signatures stay unchanged in this task.
`location_path` is non-null with default `[]`; the other new fields default null.
Store methods as checked text with the spec's five values.

- [x] Add `preserves legacy identities` against an isolated minimal legacy
  PostgreSQL schema using `runMigrations`/`writeTestMigrationFiles`. Assert IDs,
  user/source attribution, raw payloads, attached/unattached dates, tombstones,
  grades, and individual attempt rows are unchanged. Assert a six-level MP path
  becomes six nodes, a legacy gym label becomes one known node, and an existing
  40-degree value becomes `{ value: 40, unit: "degrees" }`.
- [x] Add `preserves independent results` with legacy and new rows: lead/TR/
  follow/solo/aid map to the specified nullable lead projection; successful
  labels map true; Attempt, Not sent, and Fell/Hung map false; Frenchfree and
  unfamiliar labels map null. TR with no recorded result stays null. MP/OB
  inferred totals become null; actual Kaya counts and detailed attempts remain.
  Assert `expect(trTick).toMatchObject({ lead: false, sent: null, attempt_count: null })`
  and `expect(fellHungTick).toMatchObject({ sent: false, attempt_count: null })`.
- [x] Add executable constraint tests: blank node/board names, wrong object
  shapes and known 91-degree angles are rejected; missing metadata, unknown-unit
  −20, and known zero degrees are accepted. Verify degree analytics with their
  existing progression/performance fixtures exclude unknown-unit angles.
- [x] Add provider regressions: Kaya outdoor/gym fallbacks and board on both
  feeds; CSV gym/ascent labels with missing counts; MP six-level paths with
  nullable IDs, Lead/TR/Follow/Solo and Fell/Hung; OpenBeta six aligned names/UUIDs,
  parent-only fallback, null climb, and independent style/result. `rejects
  mismatched paths` must return a specific sync error before writes or absence
  reconciliation and preserve the previous tick. Repeat syncs must preserve
  attachments and avoid duplicate source records; Kaya rejected replacements
  retain the existing session.
- [x] Run `pnpm test --run src/providers/kaya-sync.test.ts src/providers/kaya/import.test.ts src/providers/mountain-project.test.ts src/providers/openbeta.test.ts` and
  `pnpm test:integration -- src/db/climbing-context-migration.integration.test.ts src/providers/mountain-project-sync.integration.test.ts src/providers/openbeta-sync.integration.test.ts packages/server/src/repositories/kaya-sync.integration.test.ts`;
  expect the new schema and mapping assertions to fail.
- [x] Implement the transactional schema conversion. Rename and transform the
  four old columns with `ALTER COLUMN ... TYPE ... USING`, remove their obsolete
  constraints, add nullable board and validated context constraints, and clear
  MP/OB inferred counts during conversion. Migration-local conversion helpers
  must be dropped before completion. Extract existing provider style/results
  from retained raw fields before falling back to generic known outcome labels.
  Use the [PostgreSQL conversion contract](https://www.postgresql.org/docs/current/sql-altertable.html)
  and the repository migration policy; do not add a historical backfill job.
- [x] Create the permanent view. Build the complete location label in array
  order, derive the specified flags and success qualifier, and expose a degree
  value only for known units. Enforce JSONB shapes with CHECK constraints and
  immutable SQL functions `fitness.climbing_location_path_valid(value jsonb)`,
  `fitness.climbing_board_valid(value jsonb)`, and
  `fitness.climbing_wall_angle_valid(value jsonb)`, each returning boolean.
  Mirror their contract in Task 1 schemas. The
  [view contract](https://www.postgresql.org/docs/current/sql-createview.html)
  keeps these scalars computed rather than stored.
- [x] Update Kaya API and CSV mappings to write canonical facts. Outdoor nodes
  retain explicit roles; gym fallback uses climb, ascent, then session context.
  CSV supplies a gym name with null ID. Preserve raw ascent labels and nullable
  recorded counts; route lead booleans map method, boulders have no rope inference.
- [x] Update MP mappings and both insert/update sets. Split the exported path
  into trimmed nonempty names, retaining order with null roles/IDs. Use Style
  for method, Lead Style for route result, and Style for boulder result. Totals
  remain null; board and angle remain null.
- [x] Extend OpenBeta's existing query/parser with `pathTokens`, `ancestors`,
  and `parent { uuid area_name }`. Pair arrays only when lengths and any supplied
  parent identity agree. A missing ID array gives null IDs; a missing full path
  uses the known parent. Reject inconsistent supplied arrays before any writes.
  Map style and attempt type independently; totals, board, and angle remain null.
- [x] Switch scalar repository SELECTs to the view and use its `ascent_type`
  instead of reinterpreting raw payloads. Keep detailed-attempt precedence,
  source/date/access filters, existing deduplication policy, and base-table
  attachment writes. Update all current-schema fixture inserts found by
  `rg -l 'climbing_entry|climbingEntry' src packages scripts`.
- [x] Run the provider unit tests, all named database regressions, and
  `pnpm test:integration -- packages/server/src/repositories/climbing-repository.integration.test.ts packages/server/src/repositories/climbing-entry-associator.integration.test.ts packages/server/src/repositories/climbing-progression-repository.integration.test.ts packages/server/src/repositories/performance-comparison-repository.integration.test.ts packages/server/src/repositories/analytical-training-load-repository.integration.test.ts packages/server/src/routers/climbing.integration.test.ts src/db/unattached-climbing-entry.integration.test.ts src/db/climbing-attempt-count-backfill.integration.test.ts src/db/migrate.integration.test.ts`;
  expect PASS. Run root/server typechecks and
  `pnpm tsx scripts/migration-policy.ts drizzle/0135_climbing_context.sql`.
- [x] Review migration rollback, preservation assertions, and every writer/read
  site. Commit and push only the Task 3 files with
  `Store canonical climbing context and derive read projections`.

### Task 4: Serve provider-scoped context through details and suggestions

**Files:** Modify `packages/server/src/repositories/climbing-repository.ts`,
`climbing-entry-associator.ts`, their colocated tests and integration tests,
`packages/server/src/routers/climbing.ts` and its tests,
`packages/server/src/mcp/climbing-sessions-tool.ts`, and
`packages/server/src/mcp/tool-output.ts`. Create
`packages/server/src/contracts/climbing-context-contracts.ts` and its test,
`packages/server/src/mcp/climbing-sessions-tool.test.ts`, and
`packages/server/src/mcp/tool-output.test.ts`.

**Interfaces:** Add required `context: ClimbingContext` to
`ClimbingActivityEntryRow` and `ClimbingEntrySuggestion`. Existing methods,
IDs, attempt arrays, and derived scalar fields remain in the response.
MCP session climb objects expose the same `context` shape.
Export `climbingActivityEntryDetailSchema` and `climbingEntrySuggestionSchema`
from the contracts file; derive the public DTO types from those schemas.

- [x] Add `retains preferred context provider`: deduplicate matching entries
  where the more complete second source has different location/board IDs.
  Assert the context's provider and IDs travel together, independent of the
  display identity/source label. Assert the selected metadata is one source's
  snapshot and unknown metadata does not erase its nullable values.
  Assert `expect(detail.context.providerId).toBe("openbeta")` alongside the
  selected OpenBeta location UUID, even when the first display candidate was MP.
- [x] Add details/suggestions assertions for six-level paths, board, unknown
  angle, TR with null result/count, Fell/Hung, Frenchfree, and empty context.
  Test current-user/access/absence filtering with context-bearing rows and
  verify attaching a tick retains its context.
- [x] Run `pnpm test --run packages/server/src/repositories/climbing-repository.test.ts packages/server/src/repositories/climbing-entry-associator.test.ts packages/server/src/routers/climbing.test.ts`;
  expect failure because context is absent.
- [x] Add MCP regressions through `registerClimbingSessionsTool` and
  `climbingSessionsOutputSchema`: assert the tool's output preserves context,
  nullable units/results, and the same provider identity after output parsing.
- [x] Select and validate canonical fields with `climbingContextSchema`, capture
  `ce.provider_id` in the context before deduplication, and copy the entire
  preferred context together. Add output validation at both tRPC boundaries
  and MCP output. Update existing query cache key versions for changed payloads.
- [x] Run those unit tests,
  `pnpm test --run packages/server/src/contracts/climbing-context-contracts.test.ts packages/server/src/mcp/climbing-sessions-tool.test.ts packages/server/src/mcp/tool-output.test.ts`, and
  `pnpm test:integration -- packages/server/src/repositories/climbing-repository.integration.test.ts packages/server/src/repositories/climbing-entry-associator.integration.test.ts packages/server/src/routers/climbing.integration.test.ts`;
  expect PASS. Review source scoping and raw/derived boundaries, then commit
  and push the Task 4 files with `Serve provider-scoped climbing context`.

### Task 5: Matching attached and unattached displays on both clients

**Files:** Create colocated `ClimbingEntryContext.tsx`, `.test.tsx`, and
`.stories.tsx` under `packages/web/src/pages/activity-detail/components/` and
`packages/mobile/components/`. Modify web `ClimbingEntryBreakdown.tsx` and
`UnattachedClimbingEntries.tsx` and their tests/stories; add a colocated
breakdown test/story where absent. Modify `packages/web/src/pages/ActivityDetailPage.test.tsx`,
`packages/mobile/app/activity/[id].tsx`, and its existing test under
`packages/mobile/app-tests/activity/`.

**Interfaces:** Each platform exports
`ClimbingEntryContext({ context, sent }: { context: ClimbingContext; sent: boolean | null })`.
Use Task 1 label functions and the server-derived sent value for presentation.
Reuse the component in attached entries and attachment suggestions.

- [x] Add matching rendering tests: every node of a long path remains readable,
  board is labeled, TR displays Top rope, Fell/Hung displays Fell or hung,
  Frenchfree stays visible without a success color, unknown units have no °,
  and known zero degrees have °. Missing result/count remains explicitly unknown.
  Retain grade, detailed attempt chips, source, and attach-button behavior.
- [x] Run `pnpm test --run packages/web/src/pages/activity-detail/components/ClimbingEntryContext.test.tsx packages/mobile/components/ClimbingEntryContext.test.tsx`;
  expect failure because the components do not exist.
- [x] Implement wrapping context layouts with full paths, board name, angle,
  method, and result. Replace the old context/ascent badge rendering with this
  component. Use the existing shared attempt-result formatter in both suggestion
  lists. Keep loading/error states and targeted attachment invalidation.
- [x] Add matching stories for gym, outdoor six-level path, board, top-rope
  unknown result, Fell/Hung, and missing metadata. Update route/component
  fixtures with required API context; keep all mobile helpers outside `app/`.
- [x] Run the component tests, existing web unattached/breakdown tests, and
  `pnpm test --run packages/web/src/pages/ActivityDetailPage.test.tsx 'packages/mobile/app-tests/activity/[id].test.tsx'`;
  expect PASS. Run both client typechecks; review mobile wrapping and keyboard/
  screen-reader attachment labels, then commit and push Task 5 with
  `Display climbing places methods boards and results on both clients`.

### Task 6: Documentation, complete validation, and release handoff

**Files:** Create `docs/climbing-context.md`; update `docs/schema.md`,
`docs/schema.dbml`, `docs/schema.puml`, `docs/README.md`, `docs/kaya.md`,
`docs/mountain-project.md`, `docs/openbeta.md`, and relevant package READMEs.
Record completed checkpoints in this plan. Add incident notes only if an
operational problem actually occurs.

**Interfaces:** A reviewed commit/PR with validation evidence and a concrete
maintenance runbook. This task prepares the release; executing it requires
the separate release approval in the spec.

- [x] Document canonical fields, permanent projections, raw labels, known/unknown
  units and counts, provider coverage, and metadata source scoping with the
  cited audits and PostgreSQL documentation. Generate diagrams with
  `pnpm schema:diagram`.
- [x] Run `pnpm test --run`, `pnpm typecheck`, and typechecks for `dofek-server`,
  `dofek-web`, and `dofek-mobile`. Run `pnpm lint`, `pnpm lint:openapi`,
  `pnpm spellcheck`, and the explicit migration policy command. Run all affected
  database tests listed in Tasks 3–4 through `pnpm test:integration`.
  Expect PASS; resolve actual failures at their cause without weakening gates.
- [x] Run `pnpm exec stryker run stryker.ci.config.json --mutate '<changed-file:line-range list>'`
  using the changed-line selection in `.github/workflows/test.yml`'s Mutation
  Prep job. Expect no unexplained surviving mutants in the changed behavior.
  Keep this Docker-free; add focused unit cases for missed runtime branches,
  with database behavior checked by the integration suites.
- [ ] Review the whole diff against the approved spec and the five review-focus
  cases. Update the existing PR around the final change, commit documentation
  and final corrections, push, and verify required hosted checks and actionable
  review comments. Keep the current branch unless the user approves otherwise.
- [ ] Prepare the runbook's release gate: verify backup/restore evidence and
  current table size; stage the reviewed image; list every old process capable
  of reading/writing the changed table; quiesce those processes during the
  approved maintenance window; migrate; start the matching image; health-check
  scalar and context reads. PostgreSQL's
  [ALTER TABLE locking/rewrite behavior](https://www.postgresql.org/docs/current/sql-altertable.html)
  makes the maintenance boundary material. An application-image rollback alone
  does not restore the old schema.
- [ ] Prepare provider re-sync and cache refresh commands using existing
  job/window APIs, with approval covering their actual fetch scope. After release
  approval, verify saved record identities,
  richer Kaya metadata, MP method/result/path coverage, unknown attempt counts,
  both client assets, and OpenBeta fixtures if the user has no connection.
  Never claim a live OpenBeta account verification from fixture results.

## Self-review record

The plan covers every approved storage, provider, serving, display, and release
requirement. Tasks 1–2 establish independent contracts; Task 3 performs the
inseparable database/writer/scalar-reader cutover; Tasks 4–5 expose and render
the context; Task 6 supplies complete validation and the release gate. Every
review-focus condition has a named owning test. Tasks 1–5 are implemented and
pushed. Task 6 documentation, local verification, and independent review are
complete. The review's refresh-preservation, CSV result-label, OpenBeta
parent-only, and refresh-scope findings are corrected and covered by unit and
database regressions. The final merged suite passed 19,271 unit/mobile tests and
103 database tests. Hosted checks remain required. Release execution requires
separate approval and verified backup restore evidence; no context conversion
has been deployed.
