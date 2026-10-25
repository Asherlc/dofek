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
| `activity-chart-series` | [Shared activity-chart timing, gap, marker, and nearest-observation presentation policy](src/activity-chart-series.ts) |
| `activity-images` | [Activity-image metadata, captions, and shared web/mobile query refresh policy](src/activity-images.ts) |
| `climbing-grades` | Validate recorded grade components; order and convert supported free-rock grades with [Sandbag](https://github.com/OpenBeta/sandbag) |
| `climbing-context` | Validate the current Climb and Area path with recorded board, wall-angle, and hold-type context |
| `climbing-sources` | [Select route destinations and match provider attribution to tick links](src/climbing-sources.ts) for web and mobile using a supplied provider-label resolver |
| `climbing-map` | [Source locations and shared card-location/overview-marker builders](src/climbing-map.ts) for web and mobile; preserves server-selected ownership and full card positions |
| `climbing-location-map` | [Server-computed map circles and zoom bands](src/climbing-location-map.ts) shared by web and mobile; [Supercluster](https://github.com/mapbox/supercluster) groups nearby logged climbs while retaining individual source locations |
| `climbing-experience` | [Shared recorded board and wall-angle schemas](src/climbing-experience.ts) |
| `climbing-log` | [Area, Climb, Pitch, owned GradeComponent collections, ClimbingLogEntry, scoped ClimbingAttempt, and their canonical enums](src/climbing-log.ts) |
| `climbing-log-groups` | [Group log cards by their closest recorded Area identity](src/climbing-log-groups.ts), preserving original entry numbers, group order, and entries without an Area |
| `gps-coordinates` | [Complete finite latitude/longitude pairs](src/gps-coordinates.ts) for [native PostgreSQL point storage](https://www.postgresql.org/docs/current/datatype-geometric.html#DATATYPE-GEOMETRIC-POINTS) using x = longitude and y = latitude |
| `climbing-progression` | [Server-computed grade-stack contract](src/climbing-progression.ts), chart selection for recorded aid status and route methods, concise lane and setting labels, and period/exact-value formatting shared by web and mobile |
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

### Activity images

The [image presentation contract](src/activity-images.ts) retains stored-image
dimensions, source associations, and captions. Its query options refresh active
acquisition every three seconds and renew visible stored-image links every four
minutes, before the [server's five-minute signed URL lifetime](../../src/activity-images/storage.ts).
Failed link renewal retries after thirty seconds while stored images remain visible.
Empty completed results stop polling. Inactive queries discard their temporary
links; remounting or focusing the client refreshes the query. Persistence metadata excludes them from the
mobile disk cache. TanStack documents the [query refresh options](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery),
and Cloudflare describes [signed URLs as temporary bearer access](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

### Activity chart presentation

The [chart-series helper](src/activity-chart-series.ts) positions each metric's
returned observations on a proportional time axis. Continuity uses that metric's
lower-median positive sample interval with 50% timing tolerance. At least two
positive intervals are required to infer cadence; fewer observations remain
dots. The rule scales with the returned sampling interval so downsampling a long
recording does not manufacture gaps. These are Dofek display heuristics, following
[time-based gap handling](https://api.highcharts.com/highstock/plotOptions.series.gapUnit),
not a classification of sensor failure. Series with at most 20 observations and
isolated observations retain markers; dense continuous segments show markers
on hover or touch. Measurements are preserved without filling or smoothing.
The renderer can show only gaps retained in the API's downsampled observations.

### Activity icons

The [activity icon metadata](src/activity-icons.ts) owns Dofek's original rounded
outline SVG family for all 16 existing categories, including a neutral activity
glyph for unknown types. Category resolution remains shared across web and
mobile. Each glyph uses a 32-unit view box, rounded strokes, and `currentColor`
so renderers can supply a theme-appropriate foreground; see the
[SVG painting specification](https://www.w3.org/TR/SVG2/painting.html).
Web uses the shared SVG as a [CSS mask](https://www.w3.org/TR/css-masking-1/),
and mobile renders the same source through
[react-native-svg's SvgXml](https://github.com/software-mansion/react-native-svg/blob/main/USAGE.md#use-with-xml-strings).

### Climbing grades and attempts

`GradeSystem` covers recorded free, British, aid, ice, mixed, and commitment
components. `FreeRockGradeSystem` restricts numerical conversion and display
preferences to the existing Sandbag-supported free-rock scales. Grade
validation preserves A/C aid prefixes and documented modifiers/ranges rather
than converting recorded values; see theCrag's [grade definitions](https://www.thecrag.com/en/article/gradesonthecrag),
the [UIAA difficulty scales](https://theuiaa.org/documents/mountaineering/THESCALESOFDIFFICULTYINCLIMBING_p1b.pdf),
and firsthand [mixed-grade](https://publications.americanalpineclub.org/articles/13201217584)
and [ice/mixed range](https://publications.americanalpineclub.org/articles/13201213975) examples.

Published components belong to Climb/Pitch; separately reported components
belong to the log. Recorded attempts retain whole-Climb or pitch scope, original
source result labels, rope method, solo, aid, protection, fall/hang, dab, beta and
source history facts. The raw record schema and computed response schema are
separate. Server queries derive completion, result labels and counts; see the
[current model](../../docs/climbing-context.md) and
[schemas](src/climbing-log.ts).

The [log-card grouping helper](src/climbing-log-groups.ts) groups areas across
sources when their complete ordered name paths match, ignoring case and extra
whitespace. Distinct parent paths remain separate. If one source has multiple
Area IDs for the same path, the match is ambiguous and those areas remain
separate. Grouping preserves every log and its original occurrence number.

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
