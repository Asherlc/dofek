# Behavior Impact Query States TDD Plan

Write the failing component tests before changing production behavior.

**Goal:** Make Behavior Impact loading, refresh, error, retry, and empty states explicit without replacing useful prior results.

**Behavior:** An initial fetch announces a busy loading state. When the selected range changes or cached data refreshes, the previous associations remain visible while a polite status announces the refresh. A failed request displays the server error message and a retry action. A successful zero-row response displays a distinct empty state.

**Scope:** `BehaviorImpactChart` and the shared web query-state loading semantics needed to announce its initial fetch. Preserve the existing association calculation and chart presentation. This is a user-approved web-only parity exception: repository search found no equivalent Behavior Impact surface in `packages/mobile`, so adding one would create an unrelated native feature rather than update an existing counterpart.

**Docs:** TanStack Query documents that a `placeholderData` function can return the previous successful query data when the query key changes, keeping it visible while the new query fetches in the background: [Placeholder Query Data](https://tanstack.com/query/latest/docs/framework/react/guides/placeholder-query-data) and [Paginated / Lagged Queries](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries).

---

## Current Evidence

- `packages/web/src/components/BehaviorImpactChart.tsx` renders an unlabeled animated skeleton for an initial fetch.
- The impact query does not provide `placeholderData`, so changing the selected range can replace useful results with a blocking loading state.
- The component does not announce a background `isFetching` refresh.
- Initial and cached-data errors display the server error through `QueryStatePanel`, but neither state offers `refetch()` as a retry action.
- No colocated `BehaviorImpactChart.test.tsx` covers these state transitions.

## Test Strategy

- Unit: mock the tRPC query hook through the public component and assert initial busy/status semantics, the previous-data placeholder contract, non-blocking refresh visibility, exact server error text, retry behavior, and an explicit empty state.
- Shared state unit: assert that `QueryStatePanel` loading output has a named `status` region and `aria-busy="true"`.
- Integration: no server or database contract changes, so no new integration test is needed.
- UI/mobile/web parity: validate the existing web Storybook loading, error, empty, and default stories. No mobile implementation exists to update; the approved parity exception is documented above.

## File Structure

- Create: `packages/web/src/components/BehaviorImpactChart.test.tsx` — focused query-state regression coverage.
- Modify: `packages/web/src/components/BehaviorImpactChart.tsx` — preserve prior results, announce refreshes, and expose retry/empty states.
- Modify: `packages/web/src/components/QueryStatePanel.tsx` — give loading panels a useful announced status name.
- Modify: `packages/web/src/components/QueryStatePanel.test.tsx` — cover the shared loading semantics.
- Modify: `packages/web/src/components/BehaviorImpactChart.stories.tsx` only if the existing scenarios cannot exercise the final states.

## Tasks

### Task 1: Add Failing Query-State Tests

- [ ] Add a colocated component test that captures the query options and proves `placeholderData(previousData)` returns the same prior result.
- [ ] Assert the initial loading state is a named busy `status`.
- [ ] Assert cached rows remain visible while `isFetching` announces a refresh.
- [ ] Assert both initial and cached-data failures display `error.message` and call `refetch()` from a labeled retry button.
- [ ] Assert a successful empty response renders the explicit journal-data empty message.
- [ ] Run `pnpm exec vitest run --project unit packages/web/src/components/BehaviorImpactChart.test.tsx packages/web/src/components/QueryStatePanel.test.tsx` and confirm failure for the missing contracts.

### Task 2: Implement the Minimal Query-State Fix

- [ ] Pass `placeholderData: (previousData) => previousData` to the impact query.
- [ ] Use blocking loading only when no usable data exists.
- [ ] Announce initial loading and background refresh without hiding cached associations.
- [ ] Wire `refetch()` and `isFetching` into both error presentations.
- [ ] Render the successful zero-row response through the explicit empty state.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Verify and Deliver

- [ ] Run targeted Biome, web/root typechecks, the production Storybook build, repository lint, and the Docker-free unit suite.
- [ ] Inspect the loading, refresh, error, retry, and empty states in production Storybook.
- [ ] Review the diff for accessibility, stale-data preservation, web-only parity rationale, and scope.
- [ ] Commit, push, open one PR with `Fixes #2160`, link it from the issue, move the issue to In review, and monitor CI and feedback through merge.
