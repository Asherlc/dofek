# Climbing Strengths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add truthful success-by-style analysis to climbing training on web and mobile.

**Architecture:** A shared Zod response defines display-ready panels. The climbing repository projects owned, dated canonical observations; a server service deduplicates identified climbs and computes panels, coverage, and examples. Both clients render those values and keep only selection state locally.

**Tech Stack:** TypeScript, Zod, PostgreSQL/Drizzle, tRPC, React, React Native, Vitest, existing Storybook tooling.

**Spec:** `docs/superpowers/specs/2026-10-26-climbing-strengths-design.md`

## Global Constraints

- All numerical analysis and classifications are computed on the server.
- Keep bouldering, routes, attempt scope, rope method, solo/aid facts, and grade systems separate.
- Unknown outcomes do not establish failures. Unknown angle units do not establish geometry.
- Web uses a grade-by-style heatmap; mobile uses a grade selector and horizontal style profile.
- Each identified climb counts once per context in the selected period.
- No new dependency, external service, or duplicate storage. Do not switch branches.
- Write failing tests before implementation. Database semantics require executable PostgreSQL tests.
- New or changed components need colocated Storybook stories. Keep tests/helpers outside mobile `app/`.
- Root coordinates commits and automatically pushes after required lint, unit/mobile, and type checks pass.

## Review Focus

- Repeated sends and failed attempts on one climb must not inflate climb counts.
- Unknown-only attempts, missing identities, and incompatible grades must be excluded visibly.
- Cross-provider canonical observations must not duplicate the same identified climb in a panel.
- Settings, grade systems, and roped/pitch contexts must not mix silently.
- Zero success, no data, low samples, query failures, and background refreshes must remain distinct.

## Shared interface

Create `packages/training/src/climbing-strengths.ts` with `climbingStrengthsSchema` and inferred `ClimbingStrengths` plus exported production-consumed subtypes. Response:

```typescript
type ClimbingStrengths = {
  panels: Array<{
    key: string;
    contextKey: string;
    contextLabel: string;
    dimension: "wall_angle" | "hold_type" | "setting";
    setting: "indoor" | "outdoor" | null;
    grades: Array<{
      grade: string;
      gradeSortValue: number;
      sends: number;
      climbs: number;
      successRate: number | null;
    }>;
    rows: Array<{
      key: string;
      label: string;
      cells: Array<{
        grade: string;
        sends: number;
        climbs: number;
        successRate: number | null;
        differencePercentagePoints: number | null;
        sampleStatus: "no_data" | "limited" | "available";
        examples: Array<{
          logEntryId: string;
          activityId: string | null;
          name: string;
          grade: string;
          date: string;
          providerId: string;
          sourceName: string;
          sourceUrl: string | null;
          outcome: "sent" | "not_sent";
        }>;
      }>;
    }>;
    coverage: { missingTraits: number; unknownOutcomes: number };
  }>;
  coverage: { unknownOutcomes: number; missingGrades: number; missingIdentity: number };
};
```

Percentages use 0–100, rounded server-side. `setting` panels compare recorded Indoor and Outdoor and have `setting: null`; wall/hold panels compare one known setting and share a `contextKey`. Every row includes every panel grade, with null rates for zero denominators. Default to a panel with available trait observations, preferring wall angle; use setting when other traits are missing. Context/setting/grade selection is presentation-only. Add a small shared presentation helper only where both clients need the same labels or selection.

### Task 1: Server analysis and contract

**Files:** Create shared contract, server strengths service and dedicated repository with colocated unit/integration tests; modify `routers/climbing.ts` and existing canonical observation access only as required.

**Interfaces:** Produce `climbingStrengthsSchema`, `ClimbingStrengths`, and cached protected `climbing.strengths` query accepting the existing climbing date/filter input. Export the repository/service interfaces consumed in production. Mobile and web will both call this endpoint; no aggregate mobile-tab response changes are required.

- [ ] Write unit tests asserting one send plus repeated failures of the same identified climb counts as one sent climb; known failures count once; unknown-only records remain unknown; unknown-unit angles stay missing; zero and limited cells differ; known settings form separate rows and wall/hold panels.
- [ ] Run those tests and record the expected failure before implementation.
- [ ] Implement canonical projection reuse, stable climb identity, grade-context separation, server percentages/baselines/limited classification, source links, and coverage. Prefer a dedicated repository using the canonical query helper rather than duplicating its SQL. Keep current date/access-window semantics.
- [ ] Write and run real PostgreSQL integration tests for ownership, date bounds, attached/unattached records, cross-source duplicates, and filters. Fixture data must exercise `fitness.v_climbing_attempt` outcome semantics.
- [ ] Run focused unit/integration/router regression tests. Report exact commands and results, remaining data limitations, and any interface changes immediately.
- [ ] Root reviews spec compliance and quality before final integration.

### Task 2: Web heatmap

**Files:** Create `ClimbingStrengths.tsx`, colocated test/story/fixture files under web components; modify climbing training route, route tests/story fixtures where needed.

**Interfaces:** Consume `ClimbingStrengths` via `climbing.strengths`. Component props `{ data: ClimbingStrengths | undefined; loading?: boolean }`. Show query errors through existing `QueryStatePanel` in the route.

- [ ] Write failing rendering/interaction tests for panel selection, grade cells, real example links, unknown/limited/zero/no-data states, context separation, and empty/loading states.
- [ ] Run the tests red, then implement the approved heatmap using existing theme and native accessible buttons/selects. Avoid calculations on client data; display server values.
- [ ] Add Wall angle / Hold type / Indoor & outdoor selections; show available context and setting selectors only where relevant. Preserve controlled selections when background data changes.
- [ ] Add default, loading, empty, sparse, and significant source/setting stories. Integrate the query with retained cached data and visible error state; update route mocks/tests to include the query.
- [ ] Run focused unit tests and web type checking. Report evidence to root for review.

### Task 3: Mobile profile

**Files:** Create `ClimbingStrengths.tsx`, colocated test/story/fixture files under mobile components; integrate into mobile climbing training screen/card path outside `app/` as appropriate.

**Interfaces:** Consume the shared contract through the same `climbing.strengths` endpoint with current training days and filters. Keep this query independent from the aggregate training-tab payload.

- [ ] Write failing tests for selecting a grade/style/context, server-valued bars/counts, coverage disclosure, real examples, errors, loading, and no-data/limited states.
- [ ] Run red, then implement the compact profile with existing React Native components/theme, accessible pressables, readable labels, and source/activity links. Use display-ready percentages for bar width, never recompute metrics.
- [ ] Wire the query to the actual climbing section with current filters/range, preserving cached data and actionable query errors.
- [ ] Add default, loading, empty, sparse, and setting stories; run focused mobile tests and type checking.
- [ ] Root reviews spec compliance and quality before final integration.

### Task 4: Full verification and delivery

**Files:** Update web/mobile/server README notes with links to the implemented contract. Keep mockup artifacts separate from production commits.

- [ ] Review the complete diff and all three task reports for the five review-focus cases; fix concrete defects and rerun affected checks.
- [ ] Run `pnpm lint`, relevant unit tests, mobile tests, root/server/web/mobile typechecks, and executable strengths integration tests. Start workspace ClickHouse through `pnpm compose --` for SQL lint prerequisites.
- [ ] Build/render Storybook variants in browser and inspect narrow web/mobile layouts. Every started HTTP server must have a running `/Users/asherlc/bin/paseo-quick-tunnel <port>` for its lifetime; share only the emitted trycloudflare URL and direct story paths.
- [ ] Capture real implemented screenshots, review final code, commit the feature, and push automatically. Report validated behavior and the precise provider trait coverage limitation.
