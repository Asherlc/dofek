# @dofek/stats

Statistical analysis engine for finding correlations and trends in health data.

## Time-range policies

`time-range.ts` is the canonical source for selectable web and mobile time-range defaults,
visible rationale text, and stable preference keys. Screens in the same domain reuse the same
key: journal and behavior associations share `behavior`, while training and strain share
`training`.

Web persists the selected value in `localStorage`; mobile uses AsyncStorage. Both restore the
saved value when their screen remounts and fall back to the domain default when the saved value
is missing or invalid. The storage adapters follow the platform APIs documented by the
[Web Storage standard](https://html.spec.whatwg.org/multipage/webstorage.html) and
[React Native Async Storage](https://react-native-async-storage.github.io/async-storage/docs/api/).
Server-side support and computation windows are separate from these user-selectable display
policies.

## Implementation Details

### Correlation analysis

The package provides tools to describe relationships between health domains
(recovery, sleep, nutrition, activity, and body).

- **Legacy projection (`correlation.ts`)**: `pearsonCorrelation` and `CorrelationResult` retain
  the original independent-observation p-values and threshold labels for the permanent
  `correlation.compute` compatibility endpoint. Current clients do not use those fields.
- **Legacy correlation labels**: `CorrelationResult` classifies relationships into:
  - **Strong**: $|rho| \ge 0.5$ and $n \ge 30$.
  - **Emerging**: $|rho| \ge 0.35$ and $n \ge 15$.
  - **Early**: $|rho| \ge 0.2$ and $n \ge 10$.
  - **Insufficient**: Fewer than 10 samples or very low correlation.
- **Linear Regression**: `linearRegression` calculates slope, intercept, and $R^2$ to model how one metric predicts another.
- **Metric Definitions**: `CORRELATION_METRICS` defines the valid mapping between display labels and the underlying database keys (e.g., "Deep Sleep" → `deep_min`).

### Dependence-aware uncertainty

`block-bootstrap.ts` computes a deterministic 95% circular moving-block percentile interval.
The caller supplies the complete eligible calendar-day spine, including missing markers, and
filters paired values inside each resample. Blocks preserve consecutive observations because
moving-block resampling is designed for dependent stationary data
([Künsch 1989](https://doi.org/10.1214/aos/1176347265)); circular wrapping avoids treating the
two endpoints as privileged boundaries
([Politis and Romano 1992](https://mathweb.ucsd.edu/~politis/DPpublication.html)).

The implementation predeclares `ceil(n^(1/3))` as the block length, requests 2,000 valid
replicates, and stops after 20,000 deterministic attempts. The cube-root rate follows the
block-length selection literature ([Politis and White
2004](https://doi.org/10.1081/ETC-120028836)); the replicate and attempt counts are Dofek
operational choices. Degenerate inputs or runs that cannot supply every requested replicate
return explicit unavailable metadata instead of interval bounds.

The dependence-aware interval does not remove time trends or establish a direct relationship.
Current V2 responses therefore warn that autocorrelation or a shared time trend can create an
apparent correlation; unrelated trending series are the classic spurious-regression case
([Granger and Newbold 1974](https://doi.org/10.1016/0304-4076(74)90034-7)).

### Insight generation

`CorrelationResult.generateInsight` provides human-readable explanations of statistical findings, accounting for time lags (e.g., "Higher Caffeine today is associated with lower Sleep Efficiency 1 calendar day later").

Lag values represent exact calendar-day offsets. A `+1` lag compares the input
metric on one date with the outcome metric on the following calendar date; a
missing date is not replaced by the next available observation. Web and mobile
use the shared lag-formatting helpers from `correlation-lag.ts` so the selected
direction and calendar offset are described consistently.
