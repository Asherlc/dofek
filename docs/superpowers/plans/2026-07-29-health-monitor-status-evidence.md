# Health Monitor Status Evidence TDD Plan

**Goal:** Explain every health-monitor classification with its evaluated rule and reason, without relying on color.

**Behavior:** The server returns a semantic status, the exact classification rule, and a metric-specific explanation; web and iOS render that evidence with a non-color status symbol.

**Scope:** The canonical health-status contract and its existing web dashboard and iOS recovery consumers. The statistical thresholds and baseline calculations do not change.

## Current Evidence

- `packages/server/src/services/health-status.ts` classifies values by standard-deviation thresholds and already owns `statusToken`, `statusLabel`, and `explanation`.
- The health-monitor web card renders the explanation only through an HTML `title` and presents the semantic state with a color-only dot.
- The iOS health-status card renders the explanation, but its visual indicator is also a color-only dot.
- The dashboard recovery classification uses a 30-day baseline. The separate comparison in the response is a 7-day mean versus the prior 28 days, so describing the classification as a 28-day range would be inaccurate.

## Test Strategy

- Server unit: assert the exact server-authored rule at insufficient-data, moving-as-intended, within-one-deviation, one-deviation, and two-deviation boundaries.
- Web component: assert a visible rule and explanation plus a token-derived non-color symbol without client-side numeric reclassification.
- Mobile component: assert the same canonical fields and non-color symbol without client-side numeric reclassification.
- Contract: keep the new rule required by the runtime Zod schema and update representative contract fixtures.
- Storybook: show success, warning, danger, and insufficient-data variants with the complete evidence.

## File Structure

- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.ts` — require the evaluated rule in the canonical DTO.
- Modify: `packages/server/src/services/health-status.ts` — author the rule alongside the existing status and reason.
- Modify: `packages/server/src/services/health-status.test.ts` — cover every threshold boundary.
- Modify: `packages/web/src/lib/healthStatus.ts` — parse the required server field.
- Modify: `packages/web/src/components/HealthStatusBar.tsx` — render symbol, rule, and reason.
- Modify: `packages/web/src/components/HealthStatusBar.test.tsx` and `.stories.tsx` — cover and demonstrate all evidence states.
- Modify: `packages/mobile/components/HealthStatusCards.tsx` — render symbol, rule, and reason.
- Modify: `packages/mobile/components/HealthStatusCards.test.tsx` and `.stories.tsx` — cover and demonstrate all evidence states.

## Tasks

### Task 1: Add Failing Server Contract Tests

- [x] Add exact rule assertions for all classification branches and boundary values.
- [x] Run `rtk pnpm test -- --run packages/server/src/services/health-status.test.ts`.
- [x] Confirm failure because the canonical DTO has no `evaluationRule`.

### Task 2: Add Failing Client Rendering Tests

- [x] Require visible server-authored rule and reason plus a non-color symbol in web tests.
- [x] Require the same evidence and symbol in mobile tests.
- [x] Run `rtk pnpm test -- --run packages/web/src/components/HealthStatusBar.test.tsx packages/mobile/components/HealthStatusCards.test.tsx`.
- [x] Confirm both fail because the current clients omit at least the rule and symbol.

### Task 3: Implement the Minimal Canonical Contract

- [x] Add the required `evaluationRule` string to the runtime contract.
- [x] Populate it in the server classification branches without changing thresholds.
- [x] Render a symbol from `statusToken` and show the rule and reason on both clients.
- [x] Update Storybook variants and required fixtures.
- [x] Re-run the focused tests and confirm they pass.

### Task 4: Final Verification and Delivery

- [x] Run `rtk pnpm lint`.
- [x] Run `rtk pnpm tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [x] Run `rtk pnpm test`.
- [ ] Run the canonical Docker-free verification entrypoint with `mise run test:sandbox`.
- [x] Build both Storybook catalogs.
- [ ] Commit, push, open a linked PR with `Fixes #2106`, and monitor checks and feedback through merge.
