# MCP Food Consumption Time Implementation Plan

> **For the implementer:** Follow the approved design, the repository test
> policy, and the Superpowers test-driven development workflow. Record the
> failing and passing results before handing the diff back for review.

**Goal** — Preserve an explicitly reported food intake time through the existing
Dofek MCP food record lifecycle.

**Architecture** — Add `consumed_at` as an optional wire field and `consumedAt`
as an optional service input. Store it as a food record field decision and
project it through the existing current and historical repository reads.

**Tech stack** — TypeScript, Zod, PostgreSQL, Vitest, and the existing MCP tools.

**Spec** — [Cycling fueling and late-ride power](../specs/2026-11-21-cycling-fueling-and-late-power-design.md).

## Constraints

- Dofek-authored itemized food records only. Keep author and record ownership
  checks inside the existing write boundary. Reuse request replay,
  concurrency, erasure fencing, and the append-only ledger.
- An explicit ISO timestamp with a UTC offset is optional. Preserve the
  supplied instant and leave unzoned, malformed, and missing values distinct.
  Never infer the timestamp from `date`, meal, sample bounds, or write time.
- Keep the existing daily food queries, views, source selection, and web and
  mobile surfaces intact. The generic ledger already supports string field
  decisions. Reuse its views and the repository's versioned query without a
  migration. Flag evidence that contradicts that plan before changing storage.
- The comparison is a separate step, contingent on a verified fixture from a
  supported cycling import. This change need not add analytics or provider code.

## Review focus

- The documented `2026-11-21T00:15:00+02:00` is a different UTC day from its
  local diary date. Preserve the instant and the independent diary date.
- A create using an existing request ID and a different consumption time
  returns the existing conflict error. Date-only requests remain replayable.
- Clearing after updating returns the effective value to unknown. Historical
  reads, including the create and update versions, keep their prior decisions.
- Delete and restore change visibility without losing the reported time.
- Imported records and other users' records cannot acquire a Dofek-authored
  timestamp through the tool. An absent `consumed_at` remains omitted from the
  effective record payload.

## Task 1 — Optional intake time across the MCP lifecycle

**Files** — Start with `packages/server/src/mcp/food-record-tools.ts`,
`packages/server/src/mcp/food-record-output.ts`,
`packages/server/src/services/food-record-service.ts`,
`packages/server/src/repositories/food-record-types.ts`, and
`packages/server/src/repositories/food-record-repository.ts`. Extend the existing
MCP and food record service suites and update [MCP documentation](../../mcp.md).

**Interfaces** — Optional string `consumed_at` on create, optional string in
update `set`, and `consumed_at` in update `clear`. When known, expose optional
`consumed_at` and its existing-style human change provenance whose field key is
`consumed_at`. Use optional `consumedAt` for the typed service and repository
boundary. Use `consumed_at` as the ledger field key, with `set` for create and
update and `clear` for returning to unknown.

- [ ] Add MCP contract regressions for create and update forwarding the
  offset-bearing value, accepting the clear key, rejecting a missing offset and
  malformed value, and leaving date-only calls compatible. Exercise response
  schema validation and retained field provenance with a known timestamp.
- [ ] Extend the real PostgreSQL service suite. Use `2026-11-21T00:15:00+02:00`
  for creation on diary date `2026-11-21` and assert the instant is
  `2026-11-20T22:15:00Z`. Assert exact retry and changed-time conflict with the
  same request ID, update to a distinct time, clear, and confirm current and
  versioned results. Exercise account isolation, imported records, and
  delete/restore with the stored time. Include at least one date-only create.
- [ ] Observe the tests fail because the field is absent. Run the targeted unit
  test with `pnpm exec vitest run --project unit` and the targeted service test
  through `pnpm test:integration --` with the exact test paths.
- [ ] Extend the existing schemas and the service's field decision mapping.
  Reuse the itemized Dofek record identity from the existing create path.
  Append the timestamp decision on create and apply versioned updates with the
  same write fence. Reuse the latest-field and historical lineage projections
  for effective values and provenance. Keep `recorded_at` and `effective_at`
  semantics distinct from consumption and preserve the existing attempt to
  replay identical commands.
- [ ] Document MCP inputs, reads, time semantics, and compatibility. Repeat
  the targeted unit and real PostgreSQL tests and record the passing results.
- [ ] Review the diff against the spec and the focus list. Run `pnpm lint`,
  `pnpm --recursive --include-workspace-root --if-present typecheck`, and the
  relevant non-interactive unit tests. Leave the diff for the lead to review,
  commit, push, and verify through GitHub CI.

## Task 2 — Verify cycling source eligibility

- [x] Trace supported provider and file imports from their activity identity
  and timing data to the existing comparison repository. Seek a sanitized
  source fixture for a repeated protocol with a documented comparable preload,
  a bounded late effort, and direct power adequate for the existing coverage
  rules. Distinguish the imported facts from any inferred intervals.
- [x] If a source qualifies, document the evidence and prepare the scoped
  comparison task from the approved design. If no source qualifies, keep the
  comparison pending and report the exact missing import facts.

The source review found no verified matching cycling executions with both
recorded phase bounds and measured power. Peloton retains the class ID and
power series. Its client accepts a `segment_list` in the performance graph,
but the provider imports metric series from the graph and the existing test
fixtures use an empty segment list. TrainerRoad sync persists activity
summaries. Strava imports activity bounds and time-aligned streams. Dofek's
FIT decoder streams records and device evidence, and the TCX parser reads
trackpoints. These paths do not supply a verified, bounded late effort in a
comparable recorded protocol. Keep the comparison pending under the approved
design.
[Peloton graph mapping](../../../packages/peloton-client/src/parsing.ts) ·
[TrainerRoad importer](../../../src/providers/trainerroad.ts) ·
[Strava importer](../../../src/providers/strava/provider.ts) ·
[FIT decoder](../../../native/fit-decoder/README.md) ·
[TCX parser](../../../src/tcx/parser.ts)
