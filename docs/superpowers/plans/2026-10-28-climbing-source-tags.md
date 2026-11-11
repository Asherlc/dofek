# Climbing Source Tags Implementation Plan

> **Implementation:** Complete the tasks in dependency order, checking off each step after its validation and review.

**Goal:** Expose every recorded source tag in climb details and strengths on web/mobile while keeping catalogue tags informational.

**Architecture:** Decode retained provider payloads at the provider boundary into attributed tags. Reuse the current server strength calculations and source-aware log consolidation. Preserve independently released clients through the existing response-version mechanism and an additive strengths tag-panel collection.

**Tech Stack:** Existing TypeScript, Zod, tRPC, Vitest, React and React Native; no new dependencies or database schema.

**Spec:** [Approved design](../specs/2026-10-27-climbing-source-tags-design.md).

## Global Constraints

- Recorded source tags affect strengths; catalogue tags remain reference information.
- Preserve every supplied tag's literal label, source/category identity, unknown categories and custom labels.
- All numeric calculations remain on the server; web/mobile render the same response.
- No new provider, inferred labels, dependency, database migration or historical backfill.
- Keep old response versions compatible; stay on the current branch.
- Write failing behavioral tests first. Run shared checks and review before committing and pushing completed changes.

## Review Focus

- Attempted-climb and ascent payloads put tags at different paths: both decode identically.
- Repeated logs or tags must not multiply a climb's cohort membership.
- Equal tag labels from distinct sources/categories must retain distinct identities.
- Consolidated logs must preserve tags from nonpreferred source records.
- Older clients must never receive unsupported fields/dimensions in their existing response shapes.

### Task 1: Attributed recorded tags and detail responses

**Files:** Create `packages/training/src/climbing-tags.ts` and a provider-boundary decoder; modify detail contracts, hydration/consolidation, response version schema and relevant exports/tests.

**Interfaces:** Export `ClimbingTag` and `climbingTagSchema` from `@dofek/training/climbing-tags`. A tag has `providerId: string`, `sourceKey: string`, `label: string`, `categoryKey: string | null`, `categoryLabel: string | null`. Export `recordedClimbingTags(providerId: string, raw: unknown): ClimbingTag[]` from `dofek/climbing-tags`. Detail responses expose `tags?: ClimbingTag[]`; hydrators always provide arrays. Version 3 includes tags; versions 1/2 omit tags. New decoders accept earlier versions.

- [x] Add failing decoder tests for both KAYA raw shapes, categories, unknowns, missing and duplicate tags.
- [x] Run the tests and confirm the missing behavior fails; implement shared contract and source decoder.
- [x] Add failing detail/consolidation/response tests, including retained historical raw tags and nonpreferred sources.
- [x] Implement tag hydration/union and version 3 serialization without modifying stored log schema.
- [x] Run focused unit and relevant database integration tests; record results for review.

### Task 2: Server strengths for every recorded category

**Files:** Modify shared strengths schema, strengths service/repository/router and their tests; shared profile helper types as needed.

**Interfaces:** Consume Task 1's `ClimbingTag` and `recordedClimbingTags`. Add `tags?: ClimbingTag[]` to observations. Preserve `panels` exactly; return additive `tagPanels?: ClimbingStrengthsTagPanel[]`. Each tag panel shares the existing panel/profile fields, has `dimension: "tag"` and `category: { providerId: string; key: string | null; label: string }`. Export `ClimbingStrengthsDisplayPanel` as the original/tag-panel union for rendering helpers and charts. Category/tag keys are source-aware; only observed categories produce tag panels.

- [x] Add failing service tests for category cohorts, repeated logs, source/category collisions, unknown results and grade-adjusted comparisons.
- [x] Confirm failures, then reuse existing aggregation calculations for tag categories with unioned per-climb membership.
- [x] Project recorded tags from the already selected raw payload in the repository; add real-DB coverage of historical raw tags.
- [x] Advance the strengths cache key and verify old `panels` remain compatible and catalogue context never enters inputs.
- [x] Run the focused strengths and shared-contract tests; record results for review.

### Task 3: Web/mobile grouped details and category breakdowns

**Files:** Modify both `ClimbingStrengths`, chart types/options, `ClimbingLogEntryDetails`, paired tests/stories, and shared presentation helpers as needed.

**Interfaces:** Consume `entry.tags ?? []` and `data.tagPanels ?? []` from Tasks 1/2. Use source/category identity for selections; existing Wall angle/Hold type controls and tabs retain their behavior. Display observed source categories as additional breakdown choices with server-supplied category labels. Details show grouped source tags once, avoiding repeated known grip labels.

- [x] Write paired failing tests for selecting a category, all three strengths views, unknown/custom labels and grouped detail tags.
- [x] Confirm failures and implement the shared behavior with existing controls and chart renderers.
- [x] Add paired stories demonstrating multiple categories and sparse/unknown data; verify keyboard/accessibility labels.
- [x] Run focused web/mobile tests and record results for review.

### Task 4: Catalogue acquisition, client requests and delivery

**Files:** KAYA catalogue reader/tests; web/mobile responseVersion request sites and their expectations; MCP response-version consumers/tests; current coverage docs and client READMEs.

- [x] Add failing tests proving authenticated native KAYA catalogue tags are retained with source categories while public search remains valid.
- [x] Implement tag acquisition for native details and preserve all labels; retain existing direct/inherited catalogue provenance and keep cache entries informational.
- [x] Upgrade web/mobile detail requests to version 3; verify MCP version 3 retains the complete response and old versions remain compatible.
- [x] Update current docs with implementation links and the approved scope.
- [x] Review each task's diff, resolve findings, run required lint/typechecks/unit/mobile/integration checks, and visually inspect the paired stories.
- [x] Complete the verification and review gates; root commits and pushes the passing change as the final delivery action.

## Execution checkpoints

Implemented and reviewed on 2026-10-28. Each implementation task passed a
separate scope/quality review. Final whole-change review identified duplicate
literal-label collisions in ECharts radar events and Progress legends; the fix
uses source row identities and visibly numbers ambiguous radar labels. Actual
rendered ECharts events and legend actions are covered by the
[chart regressions](../../../packages/web/src/components/ClimbingStrengthsChart.test.tsx)
and [option regressions](../../../packages/web/src/components/climbing-strengths-chart-options.test.ts).
The scoped final re-review found the issue addressed with no remaining findings.

Validation:

- `pnpm exec vitest run --project unit --project mobile`: 1390 files and 22483
  tests passed; two files and 19 tests skipped by the existing suite.
- PostgreSQL repository suites: 17 strengths tests and 30 detail/consolidation
  tests passed, including historical retained raw tags.
- `pnpm lint`, root/server/web/mobile `tsc --noEmit`, and changed chart Biome
  checks passed.
- Browser inspection covered paired Storybook category selection in Styles,
  Grades and Progress, and grouped source-tag details. Mobile component
  inspection used its React Native Web Storybook surface.

Retrospective: retained raw source records avoided a migration and backfill.
Investigation was needed for provider category IDs, strict response contracts
and ECharts' formatted event names. Future tag/chart tasks should carry a
verified category table and duplicate-display-label fixture in their brief.
The existing TDD, provider-audit and final-review workflows fit this work; no
new dependency or service was required.

### Integration with updated main

While preparing PR #3143 for review, main advanced through
`78d3584ed`. Its removal of the Grades tab and clearer strengths/sparse-result
presentation are preserved; tag category breakdowns use the remaining Styles
and Progress views. The shared/server API still retains per-grade inputs and
baselines for its calculations. The combined strengths cache version is `v12`.
See the [current tabs](../../../packages/training/src/climbing-strengths-views.ts),
[server aggregation](../../../packages/server/src/services/climbing-strengths.ts)
and [router](../../../packages/server/src/routers/climbing.ts).
