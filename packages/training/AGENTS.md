# Agent Guidelines for @dofek/training

Read the [README.md](./README.md) first to understand the implementation details.

- **Canonical power algorithms**: Use the database-independent numerical functions in [`@dofek/cycling-power`](../cycling-power/README.md) for normalized power, power stress, and threshold modeling. Application consumers read the analytics worker's canonical outputs; do not add another FTP estimator or normalized-power formula. Keep source selection and provenance in app code, as documented by the [analytics architecture](../../analytics/README.md).
- **Power-duration evidence**: Reuse the elapsed-time, gap-aware [`activity_power_curve`](../../analytics/models/read_models/activity_power_curve.sql) evidence for application analysis; chart labels remain in [`power-analysis`](src/power-analysis.ts), while separately named Critical Power fitting lives in the [numerical package](../cycling-power/src/critical-power.ts).
- **Activity Classification**: Always use `isEnduranceActivity` when filtering activities for PMC or training load calculations to avoid skewing metrics with strength or yoga data.
- **Provider Mapping**: When adding a new provider, use `createActivityTypeMapper` with a specific mapping constant to ensure its types are normalized correctly.
