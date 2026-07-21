# Correlation insufficient-statistics implementation plan

## Problem

When fewer than five overlapping samples exist, the correlation explorer correctly labels the result “Insufficient” but still presents fabricated numeric statistics: Spearman `0.00`, Pearson `0.00`, R² `0.000`, and p-value `1.000`. With zero samples these quantities are undefined, not measured zeros or a measured p-value of one.

The server creates the fake values and both web and mobile render them.

## Evidence

- Reproduced in a signed Release iOS simulator build on a fresh account: `n = 0` appeared beside the numeric statistics and an insufficient-data finding.
- `packages/server/src/repositories/correlation-repository.ts` returns numeric zero coefficients/regression values and p-values of one whenever `pairCount < 5`.
- `packages/mobile/app/correlation.tsx` always renders those numeric fields.
- `packages/web/src/pages/CorrelationExplorerPage.tsx` renders the same fields without checking `confidenceLevel` or availability.

## Implementation

1. Add a failing repository test asserting that insufficient correlation results contain no inferential statistics.
2. Define one shared server response contract with `statisticsStatus: "available" | "insufficient"`, `pairCount`, and `additionalSamplesNeeded = max(0, 5 - pairCount)`. When status is `insufficient`, Spearman, Pearson, R², and p-value fields are `null`; when status is `available`, all four fields are numeric and `additionalSamplesNeeded` is `0`. Do not encode “not computed” as numeric zero/one sentinels.
3. Update web and mobile to show the sample count and insufficient-data explanation without coefficient, regression, or p-value readouts until the minimum sample size is met.
4. Preserve all current statistics, charts, and finding text for sufficient datasets.
5. Update focused component tests and Storybook stories on both platforms.

## Acceptance criteria

- With 0–4 pairs, no Spearman, Pearson, R², or p-value is presented as computed.
- The user sees the actual sample count and the number of additional overlapping samples required.
- With 5 or more valid pairs, current calculations and presentation remain available.
- Web and mobile use the same server-provided availability semantics.
- Route/schema tests prove the serialized contract at every 0–4 pair boundary and at 5 or more pairs, including `additionalSamplesNeeded = max(0, 5 - pairCount)`, a serialized value of `0` at the 5-pair boundary and above, and the required inferential-field nullability.

## Validation

- Run correlation repository tests at 0, 4, and 5-pair boundaries.
- Run focused web and mobile correlation explorer tests.
- Inspect empty and populated explorer states in browser and signed Release simulator builds.
