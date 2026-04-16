# Zones Agents

> [!IMPORTANT]
> Read the [README.md](./README.md) first for the canonical overview of this package.

## Core Mandates
- **Sync Zone Definitions**: Use `ZONE_BOUNDARIES_HRR` when performing zone aggregation in SQL to ensure database queries match the application's zone definitions.
- **Max HR / Resting HR Dependency**: Most calculations in this package require both max HR and resting HR. Always handle cases where these might be null.

## Implementation Notes
- **Zone Colors**: Standardized colors are imported from `@dofek/scoring/colors`. Use `HEART_RATE_ZONE_COLORS` for consistent chart rendering.
- **Classification Fallback**: `classifyHeartRateZone` returns `0` for heart rates below Zone 1 (i.e., < 50% HRR).
- **Polarization Index**: Requires time in all three zones to be greater than zero; otherwise, it returns `null`.
