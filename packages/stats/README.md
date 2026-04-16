# @dofek/stats

Statistical analysis engine for finding correlations and trends in health data.

## Implementation Details

### Correlation Analysis (`correlation.ts`)
The package provides tools to identify relationships between different health domains (recovery, sleep, nutrition, activity, body).

- **Pearson Correlation**: Implements `pearsonCorrelation` with a t-test for significance. It uses the `tCDF` and `regularizedBeta` functions to calculate p-values, ensuring statistical rigor.
- **Correlation Result**: The `CorrelationResult` class classifies relationships into confidence levels:
  - **Strong**: $|rho| \ge 0.5$ and $n \ge 30$.
  - **Emerging**: $|rho| \ge 0.35$ and $n \ge 15$.
  - **Early**: $|rho| \ge 0.2$ and $n \ge 10$.
  - **Insufficient**: Fewer than 10 samples or very low correlation.
- **Linear Regression**: `linearRegression` calculates slope, intercept, and $R^2$ to model how one metric predicts another.
- **Metric Definitions**: `CORRELATION_METRICS` defines the valid mapping between display labels and the underlying database keys (e.g., "Deep Sleep" → `deep_min`).

### Insight Generation
`CorrelationResult.generateInsight` provides human-readable explanations of statistical findings, accounting for time lags (e.g., "Higher Caffeine today is associated with lower Sleep Efficiency the next day").
