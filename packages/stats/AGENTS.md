# Agent Guidelines for @dofek/stats

Read the [README.md](./README.md) first to understand the implementation details.

- **Canonical correlation evidence**: Current clients use `correlation.computeV2`. Present its
  paired-calendar-day coverage, effect estimate, and dependence-aware interval without
  independent-observation p-values or categorical confidence labels. Moving-block resampling
  is intended for dependent stationary observations ([Künsch
  1989](https://doi.org/10.1214/aos/1176347265)).
- **Legacy projection**: Keep `CorrelationResult` p-values and confidence labels exact only for
  the permanent `correlation.compute` compatibility endpoint; do not make them canonical
  again.
- **Mapping Consistency**: Always use `CORRELATION_METRICS` to look up the correct `joinedDayKey` when building queries for the stats dashboard.
- **Lag Analysis**: Treat lag as an exact calendar-day offset, retain missing calendar dates,
  and describe the selected direction with the shared `correlation-lag.ts` helpers.
- **Math Reliability**: The implementations of `tCDF` and `lgamma` are sensitive; do not modify the Lanczos coefficients or approximation logic without exhaustive verification.
