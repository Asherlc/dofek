# Correlation Evidence TDD Plan

> **For agentic workers:** Write each behavior test before its production change. Keep the
> correlation analysis descriptive and do not reintroduce independent-observation
> significance claims.

**Goal:** Make correlation results decision-useful by exposing honest calendar-day coverage,
effect estimates, and a dependence-aware uncertainty interval declared in advance.

**Behavior:** The server reports selected, observed, paired, and missing calendar-day counts,
Spearman rho with a 95% circular moving-block bootstrap interval, and a linear slope. Web and
mobile render that evidence without p-values, categorical confidence claims, or causal
language.

**Scope:** Preserve the permanent legacy `correlation.compute` projection for installed-client
compatibility and add canonical `correlation.computeV2` for current web and mobile clients.
Both projections use one shared source/computation pipeline; unsupported iid fields exist only
in the exact legacy projection and are not part of V2. Update the existing correlation
surfaces and the activity-duration source. Do not add outlier cutoffs, causal claims, a new
mobile surface, or a new analytics read model.

**Docs:** Moving-block resampling is for dependent stationary observations
([Künsch 1989](https://doi.org/10.1214/aos/1176347265)); circular blocks avoid treating the
series endpoints differently
([Politis and Romano 1992](https://mathweb.ucsd.edu/~politis/DPpublication.html)); the
block-length rate declared in advance is proportional to the cube root of the sample size
([Politis and White 2004](https://doi.org/10.1081/ETC-120028836)).

---

## Current Evidence

- `packages/server/src/repositories/correlation-repository.ts` returns paired `sampleCount`
  but does not expose the selected calendar dates, per-axis observations, eligible lag pairs,
  or missing pairs.
- The same repository computes independent-observation Spearman and Pearson p-values and
  derives categorical confidence from fixed rho/sample thresholds.
- `packages/web/src/pages/CorrelationExplorerPage.tsx` and
  `packages/mobile/app/correlation.tsx` render the p-value and categorical confidence.
- The regression slope is already computed on the server but is not shown.
- Nutrition already reads the canonical `fitness.v_nutrition_daily` rows whose
  `resolution_status` is `available`.
- Activity duration still reads raw Postgres `fitness.v_activity`; the canonical serving
  source is the deduped ClickHouse `analytics.activity_summary` view.

## Test Strategy

- Unit: exact eligible calendar-day spines that retain missing markers, including missing X,
  missing Y, lag boundaries, and all-time ranges; deterministic circular moving-block interval
  bounds and metadata; explicit unavailable uncertainty for insufficient/degenerate resamples;
  descriptive insight text without p-values or confidence labels.
- Repository/router: ClickHouse activity-summary query and canonical nutrition query; exact
  legacy-projection and versioned V2 output-schema validation.
- UI/mobile/web parity: both existing surfaces prioritize interval, coverage, paired n, and
  slope while omitting p-values and categorical confidence.
- Integration: add real-engine source behavior only if the existing isolated ClickHouse and
  Postgres harness supports a focused fixture; run it in CI because local Docker is
  unavailable.

## File Structure

- Create: `packages/stats/src/block-bootstrap.ts` - reusable deterministic circular
  moving-block interval computation.
- Create: `packages/stats/src/block-bootstrap.test.ts` - 1:1 interval behavior and
  boundaries.
- Modify: `packages/server/src/repositories/correlation-repository.ts` - calendar coverage,
  uncertainty, descriptive insight, and ClickHouse activity input.
- Modify: `packages/server/src/routers/correlation.test.ts` - computation and contract tests.
- Modify: `packages/server/src/routers/correlation-range.test.ts` - source and range query
  assertions.
- Modify: `packages/server/src/routers/correlation.ts` - exact legacy projection and canonical
  versioned V2 output schema.
- Preserve: `packages/stats/src/correlation.ts` and its test - keep the exact legacy
  compatibility projection while V2 uses descriptive server text.
- Modify: web/mobile correlation components and colocated tests - evidence-first parity.
- Modify: stats/server documentation - explain the declared interval and source contract.

## Tasks

### Task 1: Add Failing Statistical and Coverage Tests

- [x] Add deterministic moving-block interval tests with known positive, negative, and
      constant series.
- [x] Add exact calendar-day coverage tests for gaps and positive lag; for `days=null`, assert
      that the selected spine starts at the earliest fetched calendar date and ends at
      `endDate`.
- [x] Add tests that insights contain effect and n but no p-value or confidence claim.
- [x] Run the focused stats/server unit tests.
- [x] Confirm the tests fail because the evidence contract is absent.

### Task 2: Implement the Minimal Server Contract

- [x] Implement the input-derived fixed-seed circular moving-block percentile interval with
      2,000 replications and block length `ceil(n^(1/3))`.
- [x] Resample the exact eligible calendar-day spine with missing markers intact, then filter
      valid pairs inside each replicate.
- [x] Model interval availability as a discriminated union and report valid replicate count.
- [x] Publish an interval only after collecting all 2,000 valid replicates; stop after a
      deterministic 20,000-attempt operational guard and report unavailable if the input is
      too sparse or degenerate.
- [x] For all-time ranges, bound the selected spine from the earliest fetched calendar date
      through `endDate`.
- [x] Build canonical V2 once and retain unsupported iid fields only in the exact legacy
      projection.
- [x] Query deduped `analytics.activity_summary` through the required ClickHouse store.
- [x] Keep canonical nutrition totals from `fitness.v_nutrition_daily`.
- [x] Run the focused stats/server source, contract, and range tests.

### Task 3: Add Failing Web and Mobile Presentation Tests

- [x] Assert both surfaces render interval, selected/paired/missing coverage, and slope with
      units.
- [x] Assert neither surface renders p-values or categorical confidence.
- [x] Run the focused web and mobile presentation tests.
- [x] Confirm the tests fail because the evidence fields are not presented.

### Task 4: Implement Evidence-First Presentation

- [x] Render shared server values on both existing surfaces.
- [x] Keep slope formatting platform-specific but do not compute statistics in a client.
- [x] Replace confidence badges with neutral method/coverage labels.
- [x] Run the focused web and mobile presentation tests.

### Task 5: Final Verification

- [ ] Run `rtk pnpm lint` (the Docker-free checks pass; local SQLFluff cannot connect to the
      required ClickHouse engine, so CI must complete this gate).
- [x] Run `rtk pnpm tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/mobile tsc --noEmit`.
- [x] Run `rtk pnpm test`.
- [x] Run Docker-free Stryker for the new statistical production module.
- [ ] Push, open the linked PR, and monitor exact-head CI and review feedback.
