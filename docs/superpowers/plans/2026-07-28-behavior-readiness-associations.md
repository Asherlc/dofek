# Behavior Readiness Associations TDD Plan

> **For agentic workers:** Write the failing tests before each implementation task. Use subagent-driven development when a bounded investigation or review can run independently.

**Goal:** Present the descriptive relationship between boolean journal behaviors and next-day readiness without causal language.

**Behavior:** Web and mobile describe the result as an association, explain the supported Yes-versus-No mean comparison, show each group’s sample count and the selected observation window, explicitly state that an uncertainty interval is not available for this comparison, and use neutral higher/lower direction language.

**Scope:** Keep the existing server-computed readiness difference and API query. Do not add a confidence interval because the behavior-impact contract does not expose the paired time series or an uncertainty estimate. Do not add an N-of-1 experiment flow because the current experiment contract has no supported mapping from a journal question to an intervention.

**Docs:** Issue [#2158](https://github.com/Asherlc/dofek/issues/2158), the existing behavior repository at `packages/server/src/repositories/behavior-impact-repository.ts`, and the separate correlation evidence contract documented in `packages/server/README.md`.

---

## Current Evidence

- `packages/web/src/routes/behavior-impact.tsx` says daily behaviors “affect” next-day readiness.
- `packages/web/src/components/BehaviorImpactChart.tsx` labels the result “impact” and the directions “HURTS” and “HELPS.”
- The server computes a descriptive percentage difference between mean next-day readiness after Yes and No entries, and returns `yesCount` and `noCount`.
- The web route already selects a 7–365 day or all-history window.
- PR #2217 neutralized journal-entry score semantics but did not change the Behavior Impact surface.
- PR #2230 added dependence-aware uncertainty to `correlation.computeV2`; that interval is not part of `behaviorImpact.impactSummary`.

## Test Strategy

- Unit: verify the server domain names the computed value as a readiness difference without changing the formula.
- Web UI: verify association wording, neutral higher/lower direction, method, Yes/No counts, selected-window context, and explicit unavailable-interval copy.
- Mobile UI: verify the same evidence and wording, explicit unavailable-interval copy, query window changes, loading/error/empty states, and navigation from Recovery.
- Integration: no new database behavior; existing repository and router coverage remains authoritative.

## File Structure

- Modify: `packages/server/src/repositories/behavior-impact-repository.ts` — give the server-owned metric a descriptive name.
- Modify: `packages/server/src/repositories/behavior-impact-repository.test.ts` — lock the descriptive API detail.
- Modify: `packages/server/src/routers/behavior-impact.ts` and test — expose the renamed server value.
- Modify: `packages/web/src/routes/behavior-impact.tsx` — replace causal page copy.
- Modify/create: `packages/web/src/components/BehaviorImpactChart.tsx` and colocated test — render honest context.
- Create: `packages/mobile/app/behavior-associations.tsx`, test, and story — add the parity surface.
- Modify: `packages/mobile/app/(tabs)/recovery.tsx`, its test, and `packages/mobile/app/_layout.tsx` — make the parity surface reachable.

## Tasks

### Task 1: Add Failing Server Contract Tests

- [ ] Update repository and router tests to expect `readinessDifferencePercent`.
- [ ] Run `rtk pnpm exec vitest run packages/server/src/repositories/behavior-impact-repository.test.ts packages/server/src/routers/behavior-impact.test.ts`.
- [ ] Confirm the tests fail because the old `impactPercent` field is still returned.

### Task 2: Implement the Minimal Server Rename

- [ ] Rename the domain getter and returned field without changing the formula or query.
- [ ] Run the focused server tests and confirm they pass.

### Task 3: Add Failing Web Tests

- [ ] Add colocated component tests for association wording, neutral direction, method, group counts, window, and explicit unavailable-interval copy.
- [ ] Extend the route consumer test to reject causal subtitle language.
- [ ] Run `rtk pnpm exec vitest run --project unit packages/web/src/components/BehaviorImpactChart.test.tsx packages/web/src/components/TimeRangeSelector.consumers.test.tsx`.
- [ ] Confirm the tests fail for the current causal presentation.

### Task 4: Implement the Web Presentation

- [ ] Replace causal page/chart wording with association language.
- [ ] Render the supported method, per-group sample counts, and selected window.
- [ ] State that an uncertainty interval is not available for this descriptive comparison.
- [ ] Use neutral styling and “lower/higher” labels.
- [ ] Update the existing Storybook fixture for the renamed server field.
- [ ] Run the focused web tests and confirm they pass.

### Task 5: Add Failing Mobile Parity Tests

- [ ] Test the association evidence, window selector, and query/error/empty states on a new screen.
- [ ] Test navigation from Recovery.
- [ ] Run `rtk pnpm exec vitest run --project mobile packages/mobile/app/behavior-associations.test.tsx packages/mobile/app/'(tabs)'/recovery.test.tsx`.
- [ ] Confirm the tests fail because the parity screen and link do not exist.

### Task 6: Implement Mobile Parity

- [ ] Add the screen using `behaviorImpact.impactSummary` without client-side metric computation.
- [ ] Add the Recovery link and stack registration.
- [ ] Add a representative mobile Storybook story.
- [ ] Run the focused mobile tests and confirm they pass.

### Task 7: Final Verification

- [ ] Run relevant lint, typecheck, unit/mobile tests, and Storybook builds.
- [ ] Review the complete diff for causal wording and unsupported statistical claims.
- [ ] Commit, push, open one PR with `Fixes #2158`, link it from the issue, and monitor CI/comments to strict readiness.
