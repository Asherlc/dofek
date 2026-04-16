# @dofek/recovery

Recovery, readiness, and stress scoring logic. Shared across web and mobile platforms.

## Features

- **Readiness Score**: A composite metric (0-100) derived from HRV, resting HR, sleep, and respiratory rate.
- **Daily Stress**: A 0-3 scale (matching Whoop) based on z-score deviations of HRV and RHR from 60-day baselines, plus sleep efficiency.
- **Sleep Consistency**: A 0-100 score based on the regularity of bed and wake times using a 14-day rolling standard deviation.
- **Weekly Aggregation**: Tools for aggregating daily stress into ISO weeks and computing trends (improving/worsening/stable).

## Implementation Details

### Readiness Calculation
The `ReadinessScore` class uses customizable weights (defaulting to 50% HRV, 20% RHR, 15% sleep, and 15% respiratory rate) to produce a weighted average of component scores.

### Stress Scale
Stress is computed in `computeDailyStress` using z-score thresholds. HRV below baseline (negative z-score) contributes up to 1.5 stress, RHR above baseline (positive z-score) contributes up to 1.0, and poor sleep efficiency (< 85%) contributes up to 0.5.

### Sleep Consistency
`computeSleepConsistencyScore` maps the average standard deviation of bed/wake times to a 0-100 score. An average stddev of < 0.5 hours results in 100, while > 1.5 hours results in 0.
