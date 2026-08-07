# Mobile sleep empty-metrics implementation plan

## Problem

The mobile Sleep screen truthfully reports that no sleep data has synced, but then displays “No sleep debt,” an average duration of `0m`, and average efficiency of `0%`. These are presented as measured 14/30-night results even though there are no nights to measure.

The client also computes the two averages from API rows, contrary to the repository's server-side metric-computation rule.

## Evidence

- Reproduced in a signed Release iOS simulator build using a fresh account with no synced sleep data.
- `packages/mobile/app/sleep.tsx` defaults `sleepDebt`, `avgDuration`, and `avgEfficiency` to zero and always renders the debt and average cards.
- `packages/server/src/routers/recovery.ts` reduces an empty `nightly` array to a numeric zero for sleep debt, without returning an availability signal.
- The same mobile screen displays a Data Readiness banner saying “No sleep data has been synced yet,” so the contradictory state is visible in one viewport.

## Implementation

1. Add a failing server test for an empty sleep result and a failing mobile test for the no-night state.
2. Return nullable/absent sleep summary metrics when there are no qualifying nights; compute average duration and average efficiency on the server alongside sleep debt.
3. Render one truthful sleep empty state on mobile and omit measured summary cards until their server metrics are available.
4. Keep the existing cards and trends for one or more valid nights, using only server-computed values.
5. Check the web recovery surface for equivalent empty-state behavior and preserve platform parity.

## Acceptance criteria

- An account with no sleep rows never sees zero-valued debt, duration, or efficiency presented as measurements.
- An account with sleep rows receives and renders correct server-computed summaries.
- Mobile does not calculate or aggregate sleep metric values from raw API rows.
- Web and mobile use equivalent availability semantics.

## Validation

- Run focused recovery-router tests with zero, one, and multiple sleep nights.
- Run focused mobile Sleep screen tests for loading, empty, and populated states.
- Inspect both web and signed Release simulator empty-account screens.
