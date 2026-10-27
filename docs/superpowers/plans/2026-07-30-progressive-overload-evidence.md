# Progressive Overload Evidence TDD Plan

**Goal:** Make each strength-volume slope decision-quality evidence by naming the exercise, exact observed period, sample count, uncertainty, and the limits of interpreting deload intent on web and iOS.

**Behavior:** The server returns dated weekly observations, fits volume against actual elapsed calendar weeks, reports a deterministic 95% dependence-aware interval or an explicit unavailable reason, and authors neutral interpretation and deload-context text. Web and iOS format units and render the same evidence without calculating or classifying the trend.

**Scope:** Extend the existing weekly strength-volume endpoint and consolidated mobile Training response. Update the existing web card and add an equivalent mobile component with paired stories. Do not prescribe a program, infer whether a deload was planned, add stored aggregates, or compute slopes or uncertainty in either client.

**Docs:** [Issue #2112](https://github.com/Asherlc/dofek/issues/2112), [block bootstraps with fixed regressors and dependent errors](https://doi.org/10.1080/01621459.2011.646929), and [`@dofek/stats` dependence-aware uncertainty](../../../packages/stats/README.md#dependence-aware-uncertainty).

---

## Current Evidence

- `StrengthRepository.getProgressiveOverload` groups recorded volume by exercise and week but discards each week label before constructing the model.
- `ProgressiveOverload` regresses against array indices, so two recorded weeks separated by a calendar gap are treated as adjacent.
- The API exposes only `weeklyVolumes`, `slopeKgPerWeek`, and direction. It does not report the observed period, number of recorded weeks, or uncertainty.
- The web card now shows the exercise and uses neutral visual styling, so those parts of the 2026-07-26 audit are stale. Its visible evidence remains only a direction and point slope.
- The consolidated mobile Training response and screen do not contain exercise-volume trend evidence.

## Test Strategy

- Unit: prove actual calendar-week offsets determine the slope; period and observation counts remain exact; available and unavailable uncertainty are explicit; and every direction receives neutral, server-authored interpretation and deload context.
- Integration: seed one exercise into real Postgres on non-consecutive weeks and verify repository/router output preserves the dates and fits against the two-week gaps.
- Web: verify exercise, observed period, `n`, interval or unavailable statement, neutral interpretation, and deload context render in the selected unit without client-side statistical work.
- Mobile: verify the consolidated server contract includes the evidence and a dedicated accessible component renders the same fields and unit formatting.
- Stories: update web and add mobile default, unavailable-uncertainty, loading, and empty variants.

## File Structure

- Create `packages/server/src/contracts/progressive-overload.ts` — shared runtime response contract.
- Create `packages/server/src/repositories/progressive-overload.ts` — server-owned regression, uncertainty, and interpretation model.
- Create `packages/server/src/repositories/progressive-overload.test.ts` — focused model tests.
- Modify `packages/server/src/repositories/strength-repository.ts` — retain dated observations and construct the model.
- Modify `packages/server/src/repositories/strength-repository.integration.test.ts` — executable Postgres gap semantics.
- Modify `packages/server/src/routers/strength.ts` and router tests — validated API output.
- Modify `packages/server/src/contracts/mobile-dashboard-contracts.ts` and mobile-training service tests — parity in the consolidated response.
- Modify `packages/web/src/components/ProgressiveOverloadCards.*` — render complete evidence and paired stories.
- Create `packages/mobile/components/ProgressiveOverloadCards.tsx`, its colocated test, and stories — native parity and accessibility.
- Modify `packages/mobile/app/(tabs)/strain.tsx`, its tests, and stories — place server evidence on Training.
- Update `packages/server/README.md` — document the evidence contract and statistical limitation.

## Tasks

### Task 1: Add Failing Server Model Tests

- [ ] Write dated-observation tests proving a skipped calendar week changes the slope denominator.
- [ ] Require exact first/last week, observed-week count, elapsed-week count, uncertainty shape, neutral interpretation, and deload context.
- [ ] Run `rtk pnpm exec vitest run --project unit packages/server/src/repositories/progressive-overload.test.ts`.
- [ ] Confirm failure occurs because the evidence model does not exist.

### Task 2: Add Failing Database and Router Tests

- [ ] Seed non-consecutive strength weeks against real Postgres.
- [ ] Assert week labels and actual elapsed-week slope through the repository and router.
- [ ] Run `rtk bash -lc 'set -a; . ./.env.local; set +a; pnpm exec vitest run --project integration packages/server/src/repositories/strength-repository.integration.test.ts'`.
- [ ] Confirm failure occurs because the repository currently collapses week labels.

### Task 3: Add Failing Web and Mobile Tests

- [ ] Require both clients to render exercise, observed period, sample count, uncertainty, neutral interpretation, and deload context.
- [ ] Require mobile cards to expose one complete accessible summary per exercise.
- [ ] Add/update default, unavailable-uncertainty, loading, and empty stories.
- [ ] Run focused web and mobile Vitest projects.
- [ ] Confirm failures occur because the response and components lack the evidence.

### Task 4: Implement the Minimum Server Contract

- [ ] Preserve dated weekly observations from the query.
- [ ] Fit against elapsed calendar weeks.
- [ ] Reuse the deterministic circular moving-block bootstrap on regression residuals with fixed week regressors.
- [ ] Return explicit unavailable metadata for too few observations, no residual variation, or an incomplete bootstrap.
- [ ] Author neutral direction and deload-context statements on the server.
- [ ] Validate both strength and mobile-dashboard outputs with the shared Zod schema.

### Task 5: Render Web and Mobile Parity

- [ ] Format server-provided kilogram rates and bounds with each platform's unit converter.
- [ ] Render all evidence without calculating a slope, interval, classification, or programming recommendation.
- [ ] Keep increasing, decreasing, and stable presentations visually neutral.
- [ ] Add an accessible complete-evidence label on mobile.

### Task 6: Final Verification

- [ ] Run focused unit, integration, web, and mobile tests.
- [ ] Run `rtk pnpm lint`.
- [ ] Run root, server, web, and mobile typechecks.
- [ ] Run the canonical Docker-free full suite with `rtk pnpm test`.
- [ ] Commit, push, open a PR with `Fixes #2112`, link it from the issue, and monitor reviews and CI through merge.
