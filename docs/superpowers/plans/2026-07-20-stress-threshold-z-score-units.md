# Stress-threshold z-score unit implementation plan

## Problem

The mobile and web personalization panels display heart-rate-variability stress thresholds as milliseconds. These values are not raw heart-rate-variability measurements: `StressThresholds` defines them as standard-deviation z-scores against a personal baseline. Showing default values such as `-2 ms, -1.5 ms, -1 ms` assigns the wrong physical unit and makes the setting misleading.

## Evidence

- Reproduced in a signed Release iOS simulator build under Settings → Algorithm Personalization, which displayed “Heart Rate Variability thresholds: -2 ms, -1 ms, -1 ms.”
- `packages/recovery/src/stress.ts` documents `hrvThresholds` as z-score thresholds and defaults them to `[-2.0, -1.5, -1.0]`.
- `packages/mobile/components/PersonalizationPanel.tsx` passes those z-scores to `formatHRV`, which appends the `ms` unit and rounds the values.
- `packages/web/src/components/PersonalizationPanel.tsx` makes the same `formatHRV` call, so the defect affects both platforms.

## Implementation

1. Format stress-threshold values explicitly as standard deviations from baseline, preserving the meaningful decimal precision; do not use the raw-heart-rate-variability formatter.
2. Use layman-readable copy such as “standard deviations from your baseline” rather than an unexplained “z-score” label.
3. Apply the same rendering on web and mobile, preferably through an existing shared formatting package if the behavior belongs there and has production consumers on both platforms.
4. Update the colocated component tests and Storybook stories on both platforms to cover default and personalized threshold values.

## Acceptance criteria

- Default thresholds retain `-2`, `-1.5`, and `-1` without a milliseconds suffix.
- The UI explains that each value is a standard-deviation threshold relative to the user's baseline.
- Web and mobile show equivalent, layman-readable output.
- Raw heart-rate-variability measurements elsewhere continue to use milliseconds.

## Validation

- Run the focused web and mobile personalization-panel tests.
- Inspect the web Settings page and a signed Release simulator build with default personalization parameters.
