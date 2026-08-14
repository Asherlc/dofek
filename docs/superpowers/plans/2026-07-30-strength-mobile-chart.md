# Strength Mobile Chart TDD Plan

> **For agentic workers:** Use the repository's `write-tests` workflow before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep estimated strength progression readable and decision-useful at narrow web widths without changing chart libraries or computing trend metrics in a client.

**Behavior:** The server describes the first-to-latest estimated-max change for each exercise. The responsive web chart renders one selectable exercise at a time, keeps a wrapping series selector outside the plot, shows the selected exercise's date span and trend evidence as text, and reserves enough plot space for visible time-axis labels.

**Scope:** Enrich the existing `strength.estimatedOneRepMax` response, update the existing ECharts component, its responsive Storybook coverage, and accessibility. Native mobile has no strength-estimated-max surface today, so adding an unlinked native screen is explicitly out of scope; the reported “mobile” surface is the narrow web layout from the UI audit. No new chart dependency, database query, trend model, or unrelated strength-page redesign.

**Docs:** GitHub issue `#2117`; `packages/server/src/repositories/strength-repository.ts`; `packages/web/src/components/EstimatedMaxChart.tsx`.

---

## Current Evidence

- `EstimatedMaxChart` places a scroll legend at the top of the same 320px ECharts canvas as every exercise series.
- The plot reserves only 40px above and the default 30px below, so long exercise names compete with
  the plot at narrow widths while time-axis labels may be hidden when space is insufficient; the
  [Apache ECharts FAQ](https://echarts.apache.org/en/faq.html) documents label-interval controls,
  explicit first/last-label controls, and grid spacing for legend overlap.
- The existing story fixes the container at 760px and only includes two short exercise names, so it cannot expose the audited narrow-width failure.
- `strength.estimatedOneRepMax` returns ordered observations but no server-authored direction/change evidence; a client would have to infer the trend to provide the recommended textual summary.

## Test Strategy

- Unit/server: assert increasing, decreasing, and unchanged first-to-latest evidence, including exact dates and rounded kilogram change.
- Unit/web: assert a single selected series, accessible selector state, series switching, server-authored direction rendering, selected date bounds, and time-axis label settings.
- Integration: retain the real Postgres router test and extend its response assertions for the server-authored evidence.
- Responsive parity: add paired desktop and 320px multi-exercise stories, plus loading and empty states.

## File Structure

- Modify: `packages/server/src/repositories/strength-repository.ts` — own estimated-max change evidence.
- Modify: `packages/server/src/repositories/strength-repository.test.ts` — exercise evidence boundaries.
- Modify: `packages/server/src/lib/chart-range.ts` — version persisted caches when a response contract
  changes.
- Modify: `packages/server/src/lib/chart-range.test.ts` — protect days-only cache versioning.
- Modify: `packages/server/src/routers/strength.ts` — expose the typed evidence contract.
- Modify: `packages/server/src/routers/router.integration.test.ts` — verify the real endpoint contract.
- Create: `packages/web/src/components/EstimatedMaxChart.test.tsx` — reproduce and protect responsive/selectable behavior.
- Modify: `packages/web/src/components/EstimatedMaxChart.tsx` — move selection outside the plot and render evidence.
- Modify: `packages/web/src/components/EstimatedMaxChart.stories.tsx` — paired desktop/mobile many-series states.
- Modify: `packages/server/README.md` — document the server/client evidence boundary.

## Tasks

### Task 1: Add Failing Server Tests

- [x] Add exact first-to-latest change assertions for up, down, and unchanged histories.
- [x] Extend the real router integration assertion for the evidence contract.
- [x] Run the focused repository unit test (using `pnpm exec vitest` because `rtk` is unavailable).
- [x] Confirm the tests fail because the evidence fields do not exist.

### Task 2: Implement Server Evidence

- [x] Add the smallest domain-model fields needed by both clients.
- [x] Keep raw observations unchanged and calculate no metric in the web component.
- [x] Run the focused unit test; the real integration test was attempted but its shared ClickHouse
      prerequisite restarted before any assertion ran, so isolated CI remains the integration gate.

### Task 3: Add Failing Web Tests

- [x] Assert wrapping, accessible outside-plot selectors and one visible series.
- [x] Assert series switching, server-authored trend text, visible date bounds, and protected axis labels.
- [x] Run the focused web unit test (using `pnpm exec vitest` because `rtk` is unavailable).
- [x] Confirm failure against the current internal-scroll-legend implementation.

### Task 4: Implement the Responsive Chart

- [x] Replace the internal legend with a wrapping, single-select control outside the plot.
- [x] Render the selected exercise's server-authored change evidence and date bounds.
- [x] Reserve the x-axis label area and request visible first/last labels.
- [x] Add paired wide and 320px many-series stories while retaining loading and empty stories.
- [x] Run focused tests and typechecks.

### Task 5: Final Verification

- [x] Run `pnpm lint`.
- [x] Run `pnpm exec tsc --noEmit`.
- [x] Run `pnpm --dir packages/server exec tsc --noEmit`.
- [x] Run `pnpm --dir packages/web exec tsc --noEmit`.
- [x] Run `pnpm test:changed` and the complete Docker-free `pnpm test` suite.
- [x] Build Storybook and verify the responsive stories.
- [ ] Commit, push, open a linked PR with `Fixes #2117`, monitor CI/reviews, and merge only after every required check passes.
