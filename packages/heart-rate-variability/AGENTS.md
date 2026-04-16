# @dofek/heart-rate-variability (Agent Info)

> **Read the README.md first!** It contains the core overview and selection strategy.

## Mandates
- **Selection Consistency**: Always use `selectDailyHeartRateVariability` when processing raw HRV samples (e.g., from Apple HealthKit) to ensure we don't include inflated "Breathe" session data in the daily baseline.
- **Sorting Requirement**: The input to `selectDailyHeartRateVariability` does not need to be pre-sorted by date, as the function handles the "earliest" finding internally using a simple minimum search.

## Context
Apple Health records HRV (SDNN) samples at various times. The "baseline" used in the dashboard MUST be the overnight reading. The implementation in `heart-rate-variability.ts` specifically targets the `startDate` to identify the first chronological record of the day.

## Implementation Details
The `selectDailyHeartRateVariability` function:
- Accepts `ReadonlyArray<{ value: number; startDate: Date | string }>`.
- Returns `number | null`.
- Treats `startDate` strings as ISO 8601.
