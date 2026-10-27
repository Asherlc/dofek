# Endurance Heuristics TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development before implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make polarization index and training monotony displays mathematically accurate, transparent, descriptive, and non-diagnostic on web and mobile.

**Behavior:** Dofek calculates Treff's published polarization index, exposes the calculation basis and primary source from the server, describes the `> 2.00` comparison as a heuristic rather than a physiological or clinical result, and presents Foster training monotony/strain without inventing an overtraining threshold.

**Scope:** Correct the existing PI formula; preserve Dofek's current all-three-zones-required rule; expose existing monotony calculation choices; update existing web PI/monotony UI and mobile PI UI; add the missing monotony summary to the equivalent mobile training screen. Do not add a new threshold, metric, read model, dependency, or diagnostic recommendation.

**Docs:** [Treff et al. (2019)](https://doi.org/10.3389/fphys.2019.00707); [Foster (1998)](https://pubmed.ncbi.nlm.nih.gov/9662690/)

---

## Current Evidence

- `packages/zones/src/zones.ts` calculates `log10((f1 / (f2 * f3)) * 100)`, but Treff's published equation is `log10((f1 / f2) * f3 * 100)`.
- The web PI chart maps the heuristic comparison to positive/danger colors and labels background regions as polarized/non-polarized.
- The web monotony chart applies an uncited client-side `> 2.0` rule, danger coloring, “high!”, and “elevated overtraining risk.”
- The server calculation uses cycling-only daily endurance load, inserts zero-load days into a seven-day calendar week, uses population standard deviation, and calculates strain as weekly load times monotony. Those choices are not visible to users.
- Mobile renders the server PI summary on its training screen but has no equivalent monotony summary.

## Test Strategy

- Unit: verify Treff's published equation and boundary classification; verify server DTO calculation inputs, explanations, and sources; verify neutral web option generation and descriptive copy.
- Integration: retain the existing ClickHouse integration coverage for the monotony query and PI route; CI will run it because local Docker is unavailable.
- UI/mobile/web parity: verify web shows formula/source without diagnostic language; verify mobile renders the same server-provided PI and monotony descriptions and calculation inputs.

## File Structure

- Modify: `packages/zones/src/zones.test.ts` and `packages/zones/src/zones.ts` - correct the PI equation.
- Modify: `packages/training/src/training-distribution.test.ts` and `packages/training/src/training-distribution.ts` - server-ready heuristic labels and descriptions.
- Modify: `packages/server/src/repositories/efficiency-repository.ts`, `packages/server/src/routers/efficiency.ts`, and tests - expose PI method metadata.
- Modify: `packages/server/src/repositories/cycling-advanced-models.ts`, `packages/server/src/repositories/cycling-advanced-repository.ts`, `packages/server/src/routers/cycling-advanced.ts`, and tests - expose monotony calculation inputs and method/source copy.
- Modify: `packages/web/src/components/PolarizationTrendChart.tsx`, `packages/web/src/components/TrainingMonotonyChart.tsx`, and tests/stories - neutral descriptive rendering.
- Modify: `packages/mobile/components/TrainingDistributionCards.tsx`, `packages/mobile/app/(tabs)/strain.tsx`, and tests - mobile monotony parity and server-provided descriptions.
- Modify: `packages/zones/README.md` and `packages/training/README.md` - cite and document the corrected calculation choices.

## Tasks

### Task 1: Add Failing Formula and Domain Tests

- [x] Update the zone tests with hand-calculated Treff examples and the exact `2.00` boundary.
- [x] Update training-distribution tests to expect heuristic, non-diagnostic labels.
- [x] Run `rtk pnpm test -- --run packages/zones/src/zones.test.ts packages/training/src/training-distribution.test.ts`.
- [x] Confirm the tests fail because the formula and descriptions are currently wrong.

### Task 2: Implement the Minimal Domain Fix

- [x] Correct the PI formula without adding a second calculation path.
- [x] Return descriptive server-ready labels and explanations.
- [x] Run the focused test command and confirm it passes.

### Task 3: Add Failing Server Contract Tests

- [x] Assert PI metadata includes the exact formula, zone basis, all-zones-required choice, primary source, and non-diagnostic explanation.
- [x] Assert monotony rows include daily mean, population standard deviation, formula/source, and descriptive interpretation computed by the server.
- [x] Run `rtk pnpm test -- --run packages/server/src/repositories/efficiency-repository.test.ts packages/server/src/repositories/cycling-advanced-repository.test.ts packages/server/src/routers/efficiency.test.ts packages/server/src/routers/cycling-advanced.test.ts`.
- [x] Confirm failures identify missing contract fields.

### Task 4: Implement Server Contracts

- [x] Select and map the already-computed daily mean and population standard deviation.
- [x] Add method metadata without adding a new heuristic threshold.
- [x] Run the focused server tests and confirm they pass.

### Task 5: Add Failing Web and Mobile Tests

- [x] Assert PI visuals no longer map the heuristic to positive/danger outcomes.
- [x] Assert monotony no longer labels `> 2` as high or diagnostic.
- [x] Assert both platforms render formulas, calculation inputs, server descriptions, and citations.
- [x] Run `rtk pnpm test -- --run packages/web/src/components/chart-options.test.ts packages/web/src/components/TrainingMonotonyChart.test.tsx packages/mobile/components/TrainingDistributionCards.test.tsx packages/mobile/app/(tabs)/strain.test.tsx`.
- [x] Confirm failures identify the current diagnostic UI and missing mobile parity.

### Task 6: Implement UI Parity

- [x] Render neutral PI and monotony visuals.
- [x] Add the existing monotony query and a minimal summary card to mobile training.
- [x] Render server-computed values and descriptions without client-side classification.
- [x] Run focused tests and confirm they pass.

### Task 7: Final Verification

- [x] Run Docker-free lint, typecheck, unit, mobile, and mutation checks.
- [ ] Let CI run database-backed integration/E2E checks because the local Docker daemon is unavailable.
- [ ] Semantically merge exact current `origin/main`, rerun affected checks, commit, push, open one PR for issue #2116, and monitor CI/reviews.
