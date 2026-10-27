# Correlation Comparison Validation TDD Plan

**Goal:** Prevent same-series correlation requests and explain why autocorrelation or a shared time trend can make different series appear related.

**Behavior:** The correlation API rejects matching metric IDs before querying data. Web and mobile make the metric already selected on the opposite axis unavailable, display server error messages if validation is bypassed, and render the interpretation warning returned by `correlation.computeV2`.

**Scope:** The current `correlation.computeV2` contract and its web/iOS consumers, plus equivalent validation on the legacy `correlation.compute` endpoint. This change does not add detrending, stationarity tests, causal claims, or a new correlation estimator.

**References:**

- Granger and Newbold showed that unrelated trending time series can produce apparently significant regressions: [Spurious regressions in econometrics](https://doi.org/10.1016/0304-4076(74)90034-7).
- Dofek's dependence-aware interval already preserves consecutive observations using moving-block resampling for dependent stationary data: [Künsch 1989](https://doi.org/10.1214/aos/1176347265).

## Current Evidence

- `packages/server/src/routers/correlation.ts` accepts any two strings and does not reject `metricX === metricY`.
- Web and mobile avoid issuing `computeV2` while their local selections match, but both pickers allow users to enter that invalid state.
- `computeV2` returns effect estimates, coverage, uncertainty, and an insight, but no warning about persistence or shared trends.
- Web renders tRPC errors through `QueryStatePanel`; the mobile correlation screen currently has no equivalent error branch.

## Test Strategy

- Server unit: prove both correlation endpoints reject identical IDs with the specific message before the repository is invoked; prove V2 responses expose the interpretation warning.
- Web unit: prove the opposite-axis option is disabled, the server warning is rendered, and a server error is passed through the existing query-state panel.
- Mobile unit: prove the opposite-axis chip is disabled, the server warning is rendered, and the specific server error is displayed.
- Repository unit: prove available and insufficient V2 results both carry the same server-authored warning.

## File Structure

- Modify: `packages/server/src/routers/correlation.ts` — input refinement and V2 response contract.
- Modify: `packages/server/src/routers/correlation.test.ts` — router validation and contract regression tests.
- Modify: `packages/server/src/repositories/correlation-repository.ts` — canonical warning on all V2 results.
- Modify: `packages/server/src/repositories/correlation-repository.test.ts` — warning coverage for both availability branches.
- Modify: `packages/web/src/pages/CorrelationExplorerPage.tsx` and its colocated test — prevent invalid choices and render server feedback.
- Modify: `packages/mobile/app/correlation.tsx` and its colocated test — matching iOS behavior.
- Modify: correlation stories — keep their mock V2 response aligned with the contract.
- Modify: package READMEs — document the interpretation boundary with primary references.

## Tasks

### Task 1: Add Failing Server Contract Tests

- [x] Add tests for same-series rejection on `compute` and `computeV2`.
- [x] Add tests for the V2 interpretation warning.
- [x] Run the focused server tests and confirm they fail for the missing validation/field.

### Task 2: Add Failing Web and Mobile Tests

- [x] Add picker tests proving the opposite-axis metric cannot be selected.
- [x] Add tests for rendering the server-authored interpretation warning.
- [x] Add tests for rendering the specific server error.
- [x] Run the focused client tests and confirm the expected failures.

### Task 3: Implement the Minimal Contract

- [x] Add one shared semantic validation used by both endpoints.
- [x] Add one canonical warning to every V2 result and its output schema.
- [x] Disable the invalid option/chip and render server feedback on web and mobile.
- [x] Update Storybook fixtures and current package documentation.

### Task 4: Final Verification and Delivery

- [ ] Run focused tests, `pnpm lint`, all package typechecks, and `pnpm test`.
- [ ] Push the linked branch and open a PR with `Fixes #2151`.
- [ ] Address all review feedback and CI root causes, then merge and verify issue/project completion.
