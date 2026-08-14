# Sleep Need Availability TDD Plan

> **Test-first workflow:** Write each failing test before its production change.

**Goal:** Stop presenting sleep-need totals and components when the previous night's sleep is missing, without breaking installed clients.

**Behavior:** New web and mobile clients consume a discriminated V2 contract. The `available` variant contains the server-computed recommendation, including debt recovery. The `missing_previous_night` variant contains only a stable actionable message. Existing V1 procedures and DTOs remain permanent projections over the same canonical computation.

**Scope:** Issue [#2125](https://github.com/Asherlc/dofek/issues/2125) only. Card collapsing (#2126), uncertainty/ranges (#2128), and the umbrella (#2061) are excluded.

---

## Current Evidence

- The existing server route computes and returns recommendation fields even when `canRecommend` is false: [`sleep-need.ts`](../../../packages/server/src/routers/sleep-need.ts).
- The web hides only the headline while still rendering components and a need line: [`SleepNeedCard.tsx`](../../../packages/web/src/components/SleepNeedCard.tsx).
- Mobile duplicates the 25% debt-recovery calculation in the client: [`index.tsx`](../../../packages/mobile/app/(tabs)/index.tsx).

## Test Strategy

- Unit: prove the canonical V2 schema/builder discriminates both states and the V1 projection remains stable.
- Server: prove both tRPC versions use the canonical computation and mobile dashboard V1/V2 routes retain their respective DTOs.
- Integration: use the existing real Postgres/ClickHouse test stack to prove missing prior-night data produces the unavailable V2 variant.
- UI parity: prove web and mobile render only the server message when unavailable and render server-owned debt recovery when available.

## File Structure

- Create `packages/server/src/contracts/sleep-need-contract.ts` and its colocated test.
- Modify `packages/server/src/routers/sleep-need.ts` and tests.
- Modify `packages/server/src/services/dashboard-overview.ts` and tests.
- Modify `packages/server/src/routers/mobile-dashboard.ts` and integration tests.
- Modify `packages/server/package.json` and `packages/server/src/types.ts` to expose the canonical contract.
- Modify the web sleep page/card, tests, and stories.
- Modify the mobile dashboard screen, tests, stories, and query invalidation/transport policy tests.

## Tasks

### Task 1: Add Failing Contract and UI Tests

- [ ] Add discriminated-contract and legacy-projection tests.
- [ ] Add web unavailable/available rendering tests.
- [ ] Add mobile unavailable/available rendering tests.
- [ ] Run focused tests and confirm expected failures.

### Task 2: Implement the Canonical Server Contract

- [ ] Add canonical computation, V1 projection, and V2 projection.
- [ ] Add `sleepNeed.calculateV2` while preserving `sleepNeed.calculate`.
- [ ] Add `mobileDashboard.dashboardV2` while preserving `mobileDashboard.dashboard`.
- [ ] Add executable missing-prior-night integration coverage.

### Task 3: Migrate Current Clients

- [ ] Move web to `calculateV2`.
- [ ] Move mobile to `dashboardV2`.
- [ ] Render no totals, components, or chart in the unavailable state.
- [ ] Render `debtRecoveryMinutes` supplied by the server.

### Task 4: Verify

- [ ] Run focused unit/integration tests.
- [ ] Run package typechecks and lint.
- [ ] Review the diff before broad validation.
