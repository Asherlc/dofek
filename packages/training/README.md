# @dofek/training

Framework-neutral TypeScript calculations for training load, cycling power,
performance modeling, activity normalization, and workout recommendations.

## Install

```sh
npm install @dofek/training
```

Requires Node.js 22.14 or newer.

## Usage

There is no root export; import the module subpath you need.

```ts
import {
  computeHrTss,
  computeTrimp,
} from "@dofek/training/pmc";

const durationMinutes = 60;
const averageHeartRate = 150;
const maximumHeartRate = 190;
const restingHeartRate = 55;

console.log({
  trimp: computeTrimp(
    durationMinutes,
    averageHeartRate,
    maximumHeartRate,
    restingHeartRate,
  ),
  hrTss: computeHrTss(
    durationMinutes,
    averageHeartRate,
    maximumHeartRate,
    restingHeartRate,
  ),
});
```

## Public API

Every public module is imported as `@dofek/training/<subpath>`.

| Subpath | Purpose |
| --- | --- |
| `activity-icons` | Normalize activity names into framework-neutral icon categories |
| `climbing-grades` | Validate, order, and convert Sandbag-supported boulder and route climbing grades |
| `cycling-workout-metrics` | Coverage-aware per-activity power, heart-rate, cadence, drift, zone, load, and interval calculations |
| `derived-cardio` | Cycling and submaximal walking/running VO2 max estimates and validation |
| `endurance-types` | Endurance and indoor-cycling type guards |
| `grade-adjusted-pace` | Grade cost factor and adjusted running pace |
| `muscle-groups` | Muscle-group expansion, totals, intensities, and display colors |
| `pmc` | TRIMP, heart-rate/power stress, FTP estimate, learned stress model, and performance-management calculations |
| `power-analysis` | Power curves, normalized power, critical-power fit, regression, and duration constants |
| `training` | Canonical activity types, provider normalization, and weekly-volume grouping |
| `training-distribution` | [Karvonen](https://pubmed.ncbi.nlm.nih.gov/13470504/) and [Treff](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2019.00707/full) weekly intensity-distribution summaries |
| `training-load` | `TrainingStressCalculator` stateful facade |
| `workout-recommendation` | Workout recommendation types and calculation |

## Model details

### Training distributions

The Treff polarization summary uses recorded cycling time in three
maximum-heart-rate zones and the published formula
`log10((f1 / f2) × f3 × 100)`, where `f1`, `f2`, and `f3` are the fractions of
total recorded cycling time in Zone 1, Zone 2, and Zone 3 respectively. Dofek
requires recorded time in every zone instead of applying the paper's
zero-Zone-2 substitution and follows the paper's rule that the index is invalid
when Zone 3 exceeds Zone 1. The `> 2.00` comparison is presented as a
descriptive training-distribution heuristic, not a physiological or medical
assessment. See
[Treff et al. (2019)](https://doi.org/10.3389/fphys.2019.00707).

### Workout recommendations

`recommendNextWorkout` combines recent activity, readiness, muscle-group
freshness, and intensity distribution. Its low/moderate/high
distribution model is informed by the three-zone observations in
[Seiler and Kjerland (2006)](https://pubmed.ncbi.nlm.nih.gov/16430681/);
the exact readiness gates, recovery windows, and recommendation rules are Dofek
product heuristics.

### Training stress and performance

- `computeTrimp` applies the package's exponential heart-rate-load formula.
- `computeHrTss` normalizes that load to the package's one-hour threshold
  reference.
- Power stress uses duration, FTP, and normalized power.
- Stress-model helpers fit a personal linear relationship from paired heart-rate
  and power observations.
- FTP estimation uses 95% of the best 20-minute average power, matching the
  [TrainingPeaks threshold procedure](https://help.trainingpeaks.com/hc/en-us/articles/204071934-How-to-Calculate-Threshold-Values-for-Power-Heart-Rate-or-Pace).

### Power and curve analysis

- Power curves use prefix sums to find the best average power across the
  package's standard durations.
- Normalized power uses 30-second rolling averages and fourth-power weighting,
  following the
  [TrainingPeaks calculation](https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power).
- Critical power fits the two-parameter relationship introduced by
  [Monod and Scherrer (1965)](https://doi.org/10.1080/00140136508930810)
  using efforts from 120 through 600 seconds.

### Cycling workout metrics

`computeCyclingWorkoutMetrics` resamples native power, heart-rate, and cadence streams to elapsed
one-second buckets without filling dropouts. A native observation is held only to the next native
timestamp when the gap is at most the bounded continuity tolerance; measured zero remains zero and
missing elapsed seconds remain missing. The result reports native observation counts, covered,
missing, and zero seconds, median sample interval, and largest gap independently for every stream.

Average power and work use covered power seconds only. Normalized power uses the package's canonical
30-second rolling/fourth-power calculation and is withheld when any elapsed power second is missing.
Intensity factor is normalized power divided by the FTP effective for that activity. Power TSS uses
`duration_hours × intensity_factor² × 100`, following the package's documented power-stress model;
both values are unavailable rather than manufactured when FTP or normalized power is missing.

Aerobic efficiency is mean synchronized power divided by mean synchronized heart rate. Cardiac drift
compares that ratio between equal elapsed-time halves as
`100 × (first_half_ratio - second_half_ratio) / first_half_ratio`; it requires at least 20 minutes
and 90% paired coverage in each half. This is a descriptive within-workout comparison, not a causal
or medical conclusion.

Recorded interval boundaries always take precedence. Without recorded intervals, the optional
detector identifies at least 30 seconds whose 30-second mean is at or above 105% of the activity's
effective FTP, merges interruptions shorter than 15 seconds, and exposes intervening recoveries.
That detector is a Dofek heuristic. Inferred intervals never receive invented targets or completion
scores.

### Terrain adjustment

Grade-adjusted pace uses a bounded approximation derived from the slope-cost
work of
[Minetti et al. (2002)](https://pubmed.ncbi.nlm.nih.gov/12183501/).
It is an estimate, not a substitute for measured effort.

### Activity normalization

Canonical activity types map provider-specific labels into one vocabulary.
Endurance filters and weekly-volume grouping keep downstream analysis
provider-neutral.

## Errors and configuration

The package performs no network requests and requires no authentication or
environment variables. Several calculations return zero or `null` when data is
invalid or insufficient; callers should validate data at external boundaries
and handle the nullable return types declared by each function. Training
calculations are estimates and are not medical advice.

## License and contributing

[MIT](./LICENSE). Source is in the
[Dofek repository](https://github.com/Asherlc/dofek/tree/main/packages/training).
Please [open an issue](https://github.com/Asherlc/dofek/issues) for bugs or API
proposals, or [submit a pull request](https://github.com/Asherlc/dofek/pulls).
