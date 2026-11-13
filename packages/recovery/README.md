# @dofek/recovery

Stress and sleep-consistency logic shared across web and mobile platforms
([stress implementation](src/stress.ts), [sleep consistency](src/sleep-consistency.ts)).

## Features

- **Daily Stress**: A 0-3 scale (matching Whoop) based on z-score deviations of HRV and RHR from 60-day baselines, plus sleep efficiency.
- **Sleep Consistency**: A 0-100 score based on the regularity of bed and wake times using a 14-day rolling standard deviation.
- **Weekly Aggregation**: Tools for aggregating daily stress into ISO weeks and computing trends (improving/worsening/stable).

## Implementation Details

### Stress Scale
Stress is computed in `computeDailyStress` using z-score thresholds. HRV below baseline (negative z-score) contributes up to 1.5 stress, RHR above baseline (positive z-score) contributes up to 1.0, and poor sleep efficiency (< 85%) contributes up to 0.5.

### Sleep Consistency
`computeSleepConsistencyScore` maps the average standard deviation of bed/wake times to a 0-100 score. An average stddev of < 0.5 hours results in 100, while > 1.5 hours results in 0.
