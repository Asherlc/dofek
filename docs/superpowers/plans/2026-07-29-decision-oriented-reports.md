# Decision-Oriented Reports TDD Plan

**Goal:** Make weekly and monthly reports explain what the available data supports doing next instead of only repeating dashboard metrics.

**Behavior:** The server adds a deterministic decision synthesis to every non-empty weekly and monthly report. The synthesis covers what changed, descriptive associations, what appears to have worked, one next experiment, and evidence limitations or missing data. Web, mobile, and new shared-report snapshots render the same server-owned synthesis without recomputing health meaning.

**Scope:** Use the period summaries already returned by the report repositories. Keep the existing metric snapshots and sharing flow, avoid causal claims or a new analytics query, and preserve compatibility with shared snapshots created before the synthesis field existed.

**Related issue:** [#2171](https://github.com/Asherlc/dofek/issues/2171)

---

## Current Evidence

- `WeeklyReportRepository` and `MonthlyReportRepository` return current and historical metric aggregates but no decision synthesis.
- `WeeklyReportCard`, `MonthlyReportContent`, and the mobile reports screen render metric grids independently.
- Shared reports persist the same server response as JSON; the web shared-report route validates old snapshots at runtime.

## Test Strategy

- Unit: prove the server synthesizer handles improvements, trade-offs, missing sleep/recovery data, and insufficient history without causal wording.
- Repository: prove empty reports have no synthesis and non-empty weekly/monthly reports attach server-generated synthesis.
- Web: prove both report components render all five synthesis sections and old shared snapshots still parse.
- Mobile: prove the reports screen renders the same server-provided synthesis and performs no client calculation.

## File Structure

- Create `packages/server/src/repositories/report-decision-synthesis.ts` and its colocated test for the shared server domain model.
- Modify weekly/monthly report repositories and tests to attach synthesis.
- Create `packages/web/src/components/ReportDecisionSynthesis.tsx` and `packages/mobile/components/ReportDecisionSynthesis.tsx` with colocated tests and representative stories.
- Modify the weekly/monthly web report components, `packages/web/src/routes/health-report.tsx`, and `packages/mobile/app/reports.tsx` to render the server response.

## Tasks

### Task 1: Add Failing Server Tests

- [ ] Add unit cases for changed metrics, descriptive co-movement, positive evidence, next-step copy, observed-period context, and missing-data limitations.
- [ ] Add repository assertions for synthesis presence and absence.
- [ ] Run `pnpm exec vitest run packages/server/src/repositories/report-decision-synthesis.test.ts packages/server/src/repositories/weekly-report-repository.test.ts packages/server/src/repositories/monthly-report-repository.test.ts`.
- [ ] Confirm the tests fail because the synthesis contract does not exist.

### Task 2: Implement the Server Synthesis

- [ ] Add the minimum shared synthesis type and deterministic weekly/monthly builders.
- [ ] Attach the result after repository metrics have been computed.
- [ ] Run the focused server tests and confirm they pass.

### Task 3: Add Failing Client Tests

- [ ] Require all five server-provided sections on web weekly/monthly reports and mobile.
- [ ] Require shared-report parsing to accept both new synthesis snapshots and legacy snapshots without the field.
- [ ] Run `pnpm exec vitest run packages/web/src/components/ReportDecisionSynthesis.test.tsx packages/web/src/components/WeeklyReportCard.test.tsx packages/web/src/components/MonthlyReportContent.test.tsx packages/web/src/routes/health-report.test.tsx --project unit`.
- [ ] Run `pnpm exec vitest run packages/mobile/components/ReportDecisionSynthesis.test.tsx packages/mobile/app/reports.test.tsx --project mobile`.
- [ ] Confirm the tests fail because the synthesis is not rendered.

### Task 4: Implement Web and Mobile Parity

- [ ] Add small render-only synthesis components and representative stories.
- [ ] Render the server payload on weekly, monthly, mobile, and newly shared reports.
- [ ] Keep legacy shared reports readable without generating decisions on the client.
- [ ] Run the focused web/mobile tests and confirm they pass.

### Task 5: Final Verification

- [ ] In Codex cloud, initialize with `SANDBOX=1 mise run cloud:init` and run the complete Docker-free verification entrypoint with `mise run test:sandbox`.
- [ ] Outside the Codex cloud sandbox, run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm --dir packages/server typecheck`.
- [ ] Run `pnpm --dir packages/web typecheck`.
- [ ] Run `pnpm test`.
- [ ] Build both Storybook catalogs if the focused checks pass.
