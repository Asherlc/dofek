# Personalization Model Cards TDD Plan

**Goal:** Show truthful, server-built evidence for every personalization model in web and mobile Settings.

**Behavior:** Each model card identifies whether the active value is learned or default, the last successful fit when known, the source window, accepted sample evidence, actual fit statistics when computed, the absence of calibrated uncertainty, and the inputs the fitter excludes.

**Scope:** Extend the existing canonical personalized-parameter JSON with backward-compatible per-model successful-fit timestamps, build the evidence contract on the server, and render it consistently on web and mobile. Do not add database columns, calculate confidence on clients, invent uncertainty intervals, or claim exact exclusion counts and rejection reasons that the fit pipeline does not retain.

**Docs:** [Issue #2180](https://github.com/Asherlc/dofek/issues/2180), [`src/personalization/README.md`](../../../src/personalization/README.md)

---

## Current Evidence

- `PersonalizedParams` stores one `fittedAt` for each refit attempt. `refitAllParams` preserves an older accepted sub-parameter when a later fitter returns no result, so that timestamp is not an exact per-model successful-fit time.
- Accepted parameter values contain qualifying sample counts. Training-load and readiness fits retain Pearson correlation; the heart-rate effort fit retains R². Sleep-target and stress-threshold fitters do not calculate a goodness-of-fit statistic.
- No fitter calculates a calibrated uncertainty interval or persists excluded-row counts and rejection reasons.
- Fitter queries and contracts do define source windows, minimum samples, quality gates, and excluded-input rules.

## Test Strategy

- Unit: parse legacy and new parameter JSON, record timestamps only for newly accepted fits, retain known timestamps for preserved fits, and generate truthful model-card fields for learned, default, and legacy states.
- API: verify `personalization.status` returns the server-built model-card contract.
- Web and mobile: verify the same evidence fields render, including unavailable fit time and uncertainty wording, with accessible grouped cards.
- Stories: retain default, personalized, loading, and empty variants with the complete server response.

## File Structure

- Modify: `src/personalization/params.ts` and its test — canonical timestamp schema.
- Modify: `src/personalization/refit.ts` and its test — timestamp successful fits without overwriting preserved timestamps.
- Create: `src/personalization/model-card.ts` and colocated test — server-ready model-card evidence.
- Modify: root `package.json` — production subpath export for the server consumer.
- Modify: `packages/server/src/repositories/personalization-repository.ts` and test — expose model cards.
- Modify: web/mobile `PersonalizationPanel` source, tests, and stories — render the shared API contract.
- Modify: `src/personalization/README.md` — document evidence semantics and limitations.

## Tasks

### Task 1: Add Failing Canonical Metadata Tests

- [ ] Add legacy-schema parsing and successful-fit timestamp tests.
- [ ] Run `rtk pnpm test -- --run src/personalization/params.test.ts src/personalization/refit.test.ts`.
- [ ] Confirm failures identify the absent metadata.

### Task 2: Implement Canonical Metadata

- [ ] Add optional per-model successful-fit timestamps to the existing JSON schema.
- [ ] Record a common attempt timestamp only for newly accepted fits.
- [ ] Preserve known timestamps for retained fits and leave legacy timestamps unavailable.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Add Failing Server Model-Card Tests

- [ ] Test learned, default, and legacy cards through the production model-card builder and repository.
- [ ] Assert exact source-window, sufficiency, fit-statistic, uncertainty, and excluded-input semantics.
- [ ] Run `rtk pnpm test -- --run src/personalization/model-card.test.ts packages/server/src/repositories/personalization-repository.test.ts`.
- [ ] Confirm failures identify the absent card contract.

### Task 4: Implement Server Model Cards

- [ ] Build all card semantics from canonical parameter values and fixed fitter contracts.
- [ ] Return cards from `personalization.status`.
- [ ] Re-run model-card, repository, and router tests.

### Task 5: Add Failing Web and Mobile Rendering Tests

- [ ] Require both clients to render last-fit, data-window, sufficiency, fit, uncertainty, and exclusion evidence.
- [ ] Require explicit unavailable wording for legacy/default facts.
- [ ] Run `rtk pnpm test -- --run packages/web/src/components/PersonalizationPanel.test.tsx packages/mobile/components/PersonalizationPanel.test.tsx`.
- [ ] Confirm failures identify missing evidence.

### Task 6: Implement Parity and Stories

- [ ] Render the server-built contract without client-side confidence classification.
- [ ] Add accessible model-card grouping and labels.
- [ ] Update default, personalized, loading, and empty Storybook fixtures.
- [ ] Re-run focused client tests.

### Task 7: Final Verification

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm -C packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm -C packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Commit, push, open a PR with `Fixes #2180`, and monitor every review and CI check through manual merge.
