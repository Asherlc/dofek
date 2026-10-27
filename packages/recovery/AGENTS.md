# Recovery Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Pure Functions Only**: This package contains pure logic with no database dependencies. It is safe to use in any environment (web, mobile, server).
- **Metric Parity**: Ensure that any changes to scoring logic are verified against both web and mobile rendering requirements.
- **Z-Score Sensitivity**: Stress calculations use caller-supplied [stress thresholds](src/stress.ts). Preserve the personalized threshold inputs when changing this logic.

## Implementation Notes
- **Readiness Weights**: The [readiness constructor](src/readiness.ts) requires caller-supplied weights; preserve that input contract.
- **Stress Trend**: `computeStressTrend` requires at least 14 days of data to determine if stress is "improving", "worsening", or "stable" based on a 0.3 score difference between the last 7 days and the previous 7 days.
- **Date Handling**: `aggregateWeeklyStress` handles ISO weeks (Monday-start) and uses local date parsing to avoid UTC shifts.
