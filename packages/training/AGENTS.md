# Agent Guidelines for @dofek/training

Read the [README.md](./README.md) first to understand the implementation details.

- **Prefer Normalized Power**: When calculating workload for cycling, always use `computeNormalizedPower` if sample data is available, as it better reflects metabolic cost than raw average power.
- **Model Efficiency**: Use the prefix sum implementation in `computePowerCurve` for any new time-series analysis to ensure $O(N)$ performance.
- **Activity Classification**: Always use `isEnduranceActivity` when filtering activities for PMC or training load calculations to avoid skewing metrics with strength or yoga data.
- **Provider Mapping**: When adding a new provider, use `createActivityTypeMapper` with a specific mapping constant to ensure its types are normalized correctly.
