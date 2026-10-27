# Mobile training empty-readiness target implementation plan

## Problem

The authenticated iOS Training tab shows a new account with no recovery or activity data a daily strain target of 10 and the explanation “Moderate recovery (50). Aim for a steady training day.” The server creates this apparently measured recovery score by initializing `readinessScore` to `50` when no recovery summary row exists.

This is misleading: the client presents a fabricated health metric and recommendation as user-specific guidance even though no readiness inputs exist.

## Evidence

- Reproduced in a signed Release build on an iPhone 17 Pro simulator against a fresh isolated account with no synced health data.
- `packages/server/src/services/mobile-training-tab.ts` initializes `readinessScore` to `50` and still calls `computeStrainTarget` when `readinessMetrics` is absent.
- `packages/server/src/services/mobile-training-tab.test.ts` currently codifies the incorrect fallback in “uses default readiness score when no recovery summary exists.”
- `packages/mobile/app/(tabs)/strain.tsx` renders any returned `strainTarget`, including its target, zone, and explanation.

## Implementation

1. Change the server training-tab response model so the strain target is absent when no readiness summary exists; do not substitute a synthetic readiness score.
2. Replace the fallback unit test with a regression test asserting that an absent recovery summary produces no strain target or readiness guidance.
3. Verify the mobile Training tab keeps its existing no-target empty state when `strainTarget` is absent, and add or update its colocated test and Storybook story if needed.
4. Check the web training surface for the same API field and preserve dual-platform behavior: neither platform should render readiness-based guidance without readiness data.

## Acceptance criteria

- A user with no recovery summary sees no recovery score, strain target, zone, or personalized target explanation.
- A user with valid recovery inputs continues to receive the existing server-computed strain target.
- Server and mobile regression tests cover both absent and present readiness data.
- The server remains the sole source of all strain-target calculations.

## Validation

- Run the focused server service tests.
- Run the focused mobile Training tab tests.
- Launch a signed Release simulator build against a fresh account and confirm the Training tab shows only truthful empty states.
