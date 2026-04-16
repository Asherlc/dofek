# Agent Guidelines for @dofek/stats

Read the [README.md](./README.md) first to understand the implementation details.

- **Statistical Significance**: Never present a correlation to the user if the `confidence` is "insufficient" or the p-value is $> 0.05$.
- **Mapping Consistency**: Always use `CORRELATION_METRICS` to look up the correct `joinedDayKey` when building queries for the stats dashboard.
- **Lag Analysis**: When analyzing habits (nutrition, activity) vs. recovery (HRV, sleep), always check for a 1-day lag as effects are rarely immediate.
- **Math Reliability**: The implementations of `tCDF` and `lgamma` are sensitive; do not modify the Lanczos coefficients or approximation logic without exhaustive verification.
