# Neutral Strength Volume Trends TDD Plan

<!-- cspell:ignore WCAG sparklines -->

**Goal:** Present exercise-volume direction without claiming that increasing load is inherently good or decreasing load is inherently bad.

**Behavior:** The server describes each regression slope as `increasing`, `decreasing`, or `stable` using the existing exact-zero boundary. The web Strength surface renders that direction in text with one neutral chart color and no positive/negative arrow or status styling.

**Scope:** Replace the unsupported `isProgressing` judgment in the existing `strength.progressiveOverload` response, update its sole web consumer and review fixture, and record that mobile has no corresponding progressive-overload surface. Do not invent a stability tolerance, infer desirability on a client, add a strength goal model, or create a new mobile feature.

**References:**

- [WCAG 2.2 Understanding 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color) says information conveyed by color must also have another visible cue.
- [W3C Complex Images guidance](https://www.w3.org/WAI/tutorials/images/complex/) recommends accompanying charts with text that summarizes the represented trend.

## Current Evidence

- At the audit SHA and current `origin/main`, `ProgressiveOverload.isProgressing` is `slopeKgPerWeek > 0`.
- `ProgressiveOverloadCards` maps `true` to a green sparkline and accent up arrow, and maps `false` to a red sparkline and down arrow.
- The API has weekly volume and its regression slope, but no per-exercise goal, recovery state, or training-plan target that could support a beneficial/harmful judgment.
- Mobile has no progressive-overload query or rendering surface.

## Test Strategy

- Server unit: prove positive, negative, and exact-zero slopes serialize as `increasing`, `decreasing`, and `stable`.
- Server router: update the public contract assertions to expect descriptive direction.
- Web unit: prove increasing and decreasing cards use explicit descriptive text, omit arrow glyphs, and use the same neutral sparkline color.
- Storybook: update the typed fixture to the new server response.

## File Structure

- Modify: `packages/server/src/repositories/strength-repository.test.ts`
- Modify: `packages/server/src/routers/strength-stress.test.ts`
- Modify: `packages/server/src/routers/router.integration.test.ts`
- Modify: `packages/server/src/repositories/strength-repository.ts`
- Modify: `packages/server/src/routers/strength.ts`
- Add: `packages/web/src/components/ProgressiveOverloadCards.test.tsx`
- Modify: `packages/web/src/components/ProgressiveOverloadCards.tsx`
- Modify: `packages/web/src/components/ProgressiveOverloadCards.stories.tsx`
- Modify: `packages/web/src/routes/training/strength.lazy.tsx`

## Tasks

### Task 1: Add Failing Server Contract Tests

- [x] Replace progression-judgment assertions with all three descriptive directions.
- [x] Run focused server tests and confirm failure against the current boolean contract.

### Task 2: Add Failing Web Tests

- [x] Test explicit increasing/decreasing text and absence of arrow glyphs.
- [x] Inspect both chart options and require the same neutral series color.
- [x] Run the colocated component test and confirm failure against the current green/red arrows.

### Task 3: Implement the Minimal Contract

- [x] Derive direction on the server from positive, negative, or exact-zero slope.
- [x] Remove `isProgressing` from the public detail type.
- [x] Render neutral blue sparklines and descriptive direction text on web.
- [x] Update the Strength subtitle and Storybook fixture.

### Task 4: Final Verification and Delivery

- [ ] Run focused server and web tests.
- [ ] Run lint, relevant typechecks, repo unit tests, and the Storybook production build.
- [ ] Push the linked branch and open a PR with `Fixes #2113`.
- [ ] Address all actionable review feedback and CI root causes, manually merge, and verify issue/project completion.
