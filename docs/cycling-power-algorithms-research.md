# Cycling power algorithms: research and consolidation

Research date: 2026-11-01. This document describes measured research and the implemented working-branch
design. The application changes have not been deployed.

## Product requirements

The selected direction is computed eFTP only, with no manual cycling FTP
setting, override, acceptance step, or profile fallback. The implementation may
independently reproduce the Intervals.icu process without claiming numerically
identical results. The user additionally requires one unified set of algorithms
for FTP and associated power calculations, rather than independent formulas in
each API, page, or read model. See the
[computed-only design](superpowers/specs/2026-11-01-computed-cycling-eftp-design.md).

## What Intervals.icu actually describes

Its developer describes reference curves modeled from a population of real
power-duration curves with Morton's three-parameter equation. A qualifying
effort selects a reference curve; modeled power at 60 minutes becomes eFTP.
This is not the same procedure as fitting a rider's incomplete recent bests
directly and using the fitted Critical Power asymptote:
[developer explanation](https://forum.intervals.icu/t/ftp-and-cp-interchangeability-some-notes/2665/2).

The developer further describes sex-specific population percentile curves,
with interpolation between neighboring reference curves. Their shapes differ,
rather than being one template multiplied by a power factor:
[reference-curve construction, posts 44–46](https://www.trainerroad.com/forum/t/how-accurate-is-eftp/42587?page=3).

The ongoing estimate rises when an activity supports a higher value and otherwise
carries forward, with gradual decay when training is reduced. A power-page
estimate calculated for selected dates is a separate quantity with no decay:
[ongoing versus period estimates](https://forum.intervals.icu/t/power-model-now-complete/1680/4).
One published description compares two weeks of training load with the previous
two weeks, but does not publish a complete equation or coefficients:
[decay explanation](https://forum.intervals.icu/t/eftp-giving-wrong-results/659/7).

Morton's three-parameter model has the form
`P(t) = CP + W′ / (t + W′ / (Pmax − CP))`, with positive, physically admissible
parameters. Its asymptote CP and its prediction at 3,600 seconds are distinct.
The original paper is
[Morton (1996), A 3-parameter critical power model](https://doi.org/10.1080/00140139608964484).
No repository implementation should silently substitute one quantity for the
other or label a mathematical fit statistic as physiological confidence.

## Verified empirical source

GoldenCheetah OpenData provides an accessible independent calibration source.
The project [repository](https://github.com/GoldenCheetah/OpenData) points to its
OSF archive. Direct HTTP inspection of the
[project metadata](https://api.osf.io/v2/nodes/6hfpz/) verified that its license
relationship identifies
[CC0 1.0 Universal](https://api.osf.io/v2/licenses/563c1cf88c5e4a3877f9e96c/).
The ordinary API was accessible even when the browser search tool returned an
access error. This observation concerns the dataset's declared license, not a
claim that every possible downstream use or privacy issue has been adjudicated.

The [file listing](https://api.osf.io/v2/nodes/6hfpz/files/osfstorage/) reported
6,614 archive entries. That is a file count, not a validated count of athletes,
cyclists, or adequately observed maximal performances.

A bounded initial audit inspected eight archives totaling 5,426,687 bytes. Their
summary JSON used schema version `1.8`, with:

```text
ATHLETE.gender
RIDES[].sport
RIDES[].date
RIDES[].METRICS.power_mmp
RIDES[].METRICS.power_mmp_secs
```

The duration and mean-max-power arrays are paired. Their grid is not uniformly
spaced, so calibration must use the explicit duration array. This permits
summary-only calibration without ingesting the raw CSV sensor streams. The
initial convenience sample was all male and cannot establish representative
population coverage.

One reproducible archive is [OSF download 3dfqc](https://osf.io/download/3dfqc/),
96,184 bytes, whose downloaded SHA256 matched the API metadata:
`2f1ad260771aed8722847cf7622028cec8793a31ac4bf3eca11c9c19b3a8d4ee`.
Another tested archive supported HTTP byte ranges: its compressed JSON summary
was approximately 1.07 MB, compared with a 31.29 MB complete archive. The
repository's existing [yauzl](https://github.com/thejoshwolfe/yauzl#class-randomaccessreader)
dependency supports a custom random-access reader, avoiding a new ZIP parser or
a second ZIP dependency.

The original FFT predictor was traced from its
[author's public group invitation](https://groups.google.com/g/fastfitnesstips/c/dR-mmTUkt7I)
to a [readable spreadsheet](https://docs.google.com/spreadsheets/d/1kMCa5ub6eHTG3itDdbwOyAYNmyG14rpdeZmy-UWV5pg/edit)
and [current calculator](https://fastfitness.tips/curve.html).
Neither establishes that it exposes the particular reference tables used by
Intervals.icu or grants redistribution rights. Do not copy its parameters into
the application on the basis of read access alone.

## Calibration requirements

The independent reference-data build must be reproducible and separate from
runtime estimation. Record source versions/checksums, license metadata,
selection criteria, cohort exclusions, train/held-out athlete identities through
non-identifying split keys, duration coverage, model coefficients, and error
summaries. Commit aggregate reference parameters and provenance, not individual
athlete histories.

Validate cycling records, explicit duration grids, finite nonnegative powers,
source identity duplication, and physically admissible model parameters.
Compare candidate fitting windows and weighting rules before choosing them.
Keep the held-out split at the athlete level, so the same athlete's rides cannot
appear in both calibration and evaluation.

Observed long-duration bests are performance evidence, not independently tested
physiological FTP labels. Their absence or submaximal nature must not be hidden
by reporting prediction error as clinical or laboratory accuracy. Evaluate
coverage and bias separately for available cohorts. Do not infer a user's sex
or manufacture sex-specific confidence from inadequate calibration coverage.

## Empirical experiments

These are exploratory comparisons, not production coefficients or physiological
FTP validation. All reported errors compare a prediction with a recorded long
effort, which may itself be below the athlete's capacity.

### Original CC0 archives

A predeclared 64-position audit sampled evenly spaced positions in the 6,614-file
API listing: one-based position `1 + floor(i × (6614 − 1) / 63)` for `i=0..63`.
Every position completed; no failed position was replaced. Summary-only range
downloads transferred 36,820,389 bytes. The API's default order is not guaranteed
to be random or immutable; a production calibration needs a frozen file manifest.

The archives represented 62 male and two female athletes; 59 had cycling data.
Requiring exact five- and twenty-minute observations left 51 athletes, only one
female. Position modulo four defined the held-out split before fitting: 40
training athletes and 11 held out. All eleven had 60-minute observations, but
the shared in-range five-minute comparison admitted only nine.

For each training duration, construct empirical 10th through 90th percentile
reference powers, in ten-percentile steps, with linear quantile interpolation.
Fit `P(t) = CP + W′/(t + tau)` with positive parameters and relative squared
error. Search 1,401 logarithmically spaced `tau` values from 0.001 to 10,000
seconds; solve conditional weighted linear regression for `CP` and `W′` at each
value, with weight `1/P²`. Compare fitting durations beginning at one, sixty,
or 180 seconds, all ending at 1,200 seconds. The available duration grid is
`[1,5,15,30,60,120,180,300,480,600,900,1200]` seconds.

At an athlete's observed five-minute power, interpolate between the two
bracketing reference curves and predict 60-minute power. Do not extrapolate
outside the reference bank. On the same nine admitted held-out athletes:

| Reference fit range | Median signed difference | Median absolute difference | 90th percentile absolute difference |
| --- | ---: | ---: | ---: |
| 1 second–20 minutes | +11.42% | 11.42% | 19.00% |
| 1 minute–20 minutes | +10.83% | 10.83% | 18.26% |
| 3 minutes–20 minutes | +5.63% | 5.63% | 15.94% |
| 95% of observed 20-minute power | +6.78% | 6.78% | 13.68% |

The last row uses a substantially longer input than the five-minute predictors;
it is context, not an equal-information contest. Nine cases cannot select a
production winner, and the sex distribution cannot support general claims.

### Broader published derivative

[Drake, Finke and Ferguson's study](https://doi.org/10.1007/s00421-023-05274-5)
compares endurance models using GoldenCheetah observations. The authors expose
a processed numerical table in their
[analysis repository](https://github.com/jonahd99/PL_vs_CP). Its
[frozen data artifact](https://raw.githubusercontent.com/jonahd99/PL_vs_CP/692d9741d441d68f4108b92bc37c13fd9774c852/figure_data/df_gc.Rds)
is 6,246,523 bytes, SHA256
`ba37f74817b00f529c0ce14c5eaf463f533fe0106758f182645f2b1f8347375f`.
It was decoded without executing or copying the authors' R implementations.
The repository has no explicit license; this derivative is used for exploratory
comparison, not redistributed or adopted as the production coefficient source.

Inspection found 223,081 rows and 6,031 integer athlete IDs, with duration,
power, and duration-times-power columns. There is no sex or original UUID map.
The table's largest duration is 3,480 seconds (58 minutes), not one hour.
The authors' [processing notebook](https://github.com/jonahd99/PL_vs_CP/blob/692d9741d441d68f4108b92bc37c13fd9774c852/rmd/large_data_study_in_cycling.Rmd)
and [cleaning implementation](https://github.com/jonahd99/PL_vs_CP/blob/692d9741d441d68f4108b92bc37c13fd9774c852/script/gc_cleaning.R)
apply population-percentile exclusions and decreasing-power filters. This is
not an unselected population sample or the paper's final 5,805-person analysis
cohort. Original-archive overlap cannot be ruled out without UUIDs.

Require five- and twenty-minute observations, then assign athletes to a stable
internal split using the first twelve hexadecimal digits of
`SHA256(artifact_sha256 + ':' + integer_id)`, modulo four: zero is held out.
This produces 2,567 training and 848 held-out athletes; 526 held-out athletes
have the 58-minute target. Repeat the same reference construction and fits;
the earliest available duration is now five seconds. On the same 427 held-out
athletes admitted by all three banks for five-minute to 58-minute prediction:

| Reference fit range | Median signed difference | Median absolute difference | 90th percentile absolute difference |
| --- | ---: | ---: | ---: |
| 5 seconds–20 minutes | +15.17% | 15.17% | 31.72% |
| 1 minute–20 minutes | +12.70% | 12.70% | 28.47% |
| 3 minutes–20 minutes | +7.91% | 8.10% | 23.20% |
| 95% of observed 20-minute power | +8.68% | 8.68% | 18.35% |

A coverage sensitivity check required every fitting duration for each training
athlete. It left 955 training and 327 held-out athletes. On the same 182
admitted long-target cases, median signed differences were +16.20%, +12.61%,
and +6.12%, respectively. The fitting-range sensitivity therefore does not
disappear when the duration cohorts are held constant.

These findings support testing fit-range choices explicitly. They do not show
that Intervals.icu has these errors, that recorded 58-minute power is true FTP,
or that subtracting a measured bias would calibrate physiological capacity.
Both datasets are now exploratory: choosing a model after inspecting their
held-out results requires a fresh final evaluation set.

### Does observed long-duration calibration evidence help?

A final exploratory comparison kept the same three-parameter model, fitting
weights, split, and reference interpolation. Restricting the processed table to
athletes with five-, twenty-, and 58-minute endpoints yielded 1,676 training and
526 held-out athletes. Fit one bank on available durations from 180–1,200
seconds and another from 180–3,480 seconds. Their respective axes contained 30
and 49 durations; training coverage per duration ranged from 1,172 to 1,676.
Compare only held-out athletes admitted by both banks:

| Input / common cases | Fit range | Median signed difference | Median absolute difference | 90th percentile absolute difference |
| --- | --- | ---: | ---: | ---: |
| 5 minutes / 425 | 3–20 minutes | +9.22% | 9.37% | 24.26% |
| 5 minutes / 425 | 3–58 minutes | −1.00% | 5.80% | 14.34% |
| 20 minutes / 407 | 3–20 minutes | +9.08% | 9.08% | 18.34% |
| 20 minutes / 407 | 3–58 minutes | +1.30% | 4.14% | 10.49% |

Neither bank had neighboring-curve crossings or parameter-search boundary fits.
Adding observed long-duration calibration evidence materially reduced the
discrepancy in this dataset. This remains reference-curve matching; it does not
require a second runtime estimator. It is an independently explored fitting
choice, not a claim that Intervals.icu uses this longer fitting window.

The comparison reuses inspected validation athletes and the same processed,
selected dataset. It cannot supply a fresh final-test score, physiological FTP
accuracy, a numerical correction factor, or distributable production parameters.
It specifically motivates testing long-duration calibration evidence in the
next original-CC0 calibration round.

## Selected original-source calibration

The implementation uses a fresh deterministic 256-archive original-CC0 sample,
excluding the 64 raw pilot identities. All selections were attempted: 252
archives decoded, with two declared size-cap exclusions and two malformed
upstream summaries. Transfer was 156,331,439 bytes, within the 192 MiB bound.
The [frozen public manifest](cycling-power-source-manifest.json) has SHA256
`2c4843dc2fb080b2d1c4ee992b989d6453b847de08a9ab801e0ea69ece4ca2bb`.

Requiring every fitting duration from 180 through 3,600 seconds yielded 212
athletes: 161 training and 51 held out. The predeclared hash split was not
reselected. Nine pooled P10–P90 Morton reference curves used the same positive
parameter fit and relative-error objective described above. The resulting
[aggregate bank](../src/analytics/cycling-reference-bank.json) and
[application policy](../src/analytics/cycling-power-policy.ts) remain outside
[the reusable algorithms package](../packages/cycling-power/README.md).

| Input → observed 60-minute best | Admitted held-out athletes | Median signed difference | Median absolute difference | P90 absolute difference |
| --- | ---: | ---: | ---: | ---: |
| 5 minutes | 42 | −4.26% | 5.26% | 15.32% |
| 10 minutes | 41 | −3.31% | 5.96% | 15.26% |
| 20 minutes | 39 | +1.23% | 3.74% | 8.15% |

No neighboring curves crossed and no fit hit the parameter-search boundary.
Outside-bank exclusions were 9, 10 and 12 athletes respectively; no extrapolated
or clamped predictions enter these scores. Approximate anchor domains are
236–439 W at five minutes and 192–351 W at twenty minutes; modeled hour powers
at the bank endpoints are approximately 161–299 W. These are supported-model
domains, not limits on human capacity.

Limitations remain material. All held-out athletes were male; five eligible
female athletes were in training. The original records contain suspect power
extrema and were not repaired or screened using invented physiological ceilings.
Percentile fitting limits direct influence of extrema but does not prove clean
calibration. Lifetime MMP observations may span fitness states and are lower
bounds on capacity, not independent physiological FTP labels. The processed
broader exploratory dataset lacks UUID mapping, so disjointness from that study
cannot be certified. These scores assess fixed-anchor prediction, not individual
physiological uncertainty or the maximum-over-efforts rule in every training
pattern. The application labels uncertainty unquantified and unsupported input
unavailable. It does not claim Intervals.icu numerical parity.

The selected decay policy is separately versioned application configuration:
after 28 elapsed calendar days from the first admitted activity, compare the two completed 14-day dose windows and apply
at most 0.1% decline per day in proportion to the dose deficit. Days without recorded cycling contribute zero dose; two empty windows are modeled
as inactivity. A recorded ride with incomplete power coverage withholds decline.
The elapsed-day gate does not require 28 days containing samples. This is
a conservative product heuristic, not a recovered Intervals formula or a
validated universal detraining coefficient.

## Decay is a model choice, not a known physiological constant

The published Intervals.icu explanation establishes qualitative behavior but
does not supply the exact numerical decay rule. Scientific evidence also does
not justify converting every reduction in training into one universal FTP loss:

- A study of twelve trained male cyclists found maintained measured adaptations
  during 21 days of reduced training, with six hours of cycling per week:
  [Rietjens et al. (2001)](https://pmc.ncbi.nlm.nih.gov/articles/PMC1724429/).
- A different study of ten young male road cyclists found decreases in threshold
  power after five weeks of complete training cessation:
  [Monaldo-Martin et al. (2017)](https://eprints.glos.ac.uk/3765/).

These populations and interventions differ. Their results support distinguishing
maintenance, reduced training, and cessation; they do not establish a precise
daily eFTP decay coefficient for all users. Any independently chosen coefficient
must be documented as a Dofek heuristic, assessed against historical evidence,
and never described as the Intervals.icu coefficient.

The load comparison can avoid a circular dependence on the threshold. Define
one intermediate `dose = NP² × elapsed_seconds`. Power TSS is then
`dose / (36 × eFTP²)`. When both comparison windows use the same reference
threshold, its denominator cancels, so the ratio of summed dose equals the
ratio of their summed TSS. It does not generally equal a ratio of historical
TSS values calculated using different thresholds. This is algebra over the
[power-TSS definition](https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/),
and a proposed Dofek implementation detail, not a claim about Intervals internals.

Missing power/NP coverage makes the corresponding load comparison unknown;
it must not become a zero-load day. Confirmed absence of cycling activity is a
different state and can contribute zero. Unknown load must not trigger modeled
decline merely because the application lacks observations.

## Pre-change audit of conflicting implementations

The following findings describe the implementation before this change; links are pinned to that source revision.

| Consumer | Pre-change threshold or power behavior |
| --- | --- |
| [Power repository](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/power-repository.ts) | Current eFTP is a 90-day CP fit; trend and fallback use workout NP × 0.95. A raw fallback uses sample-count duration windows. |
| [Cycling analytics](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/cycling-analytics-repository.ts) | Repeats the CP/current and NP/trend split; variability selects another 20-minute-based threshold. |
| [Advanced cycling](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/cycling-advanced-repository.ts) | Uses selected-range maximum 20-minute summary power × 0.95. |
| [Cycling performance](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/cycling-performance-repository.ts) | Recalculates a rolling-90-day best-20-minute threshold for each ride. |
| [Threshold estimator](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/cycling-threshold-estimator.ts) | Exposes configured, sustained-power, 20-minute, and CP strategies through a selection hierarchy. |
| [Threshold history](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/cycling-threshold-repository.ts) | Serves manual dated settings and legacy profile FTP. |
| [PMC](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/pmc-repository.ts) | Uses 95% of the best whole-ride average from rides lasting at least 20 minutes, applying one threshold across the queried history. |
| [Calendar scoring](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/activity-calendar-entry.ts) | Reads profile FTP and passes average power as the normalized-power argument to TSS. |
| [Workout metrics](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/cycling-effort-metrics.ts) | Uses dated manual FTP for IF, TSS, zones, and inferred intervals. |
| [Analytical load](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/repositories/analytical-training-load-repository.ts) | Uses manual dated FTP and summary NP. |
| [Activity zones](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/server/src/routers/activity.ts) | Uses today's 90-day CP estimate to classify historical activities. |
| [Healthspan](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/analytics/models/read_models/healthspan_activity_zone_minutes.sql) | Uses profile FTP and sample-count proportions scaled to full activity duration; unavailable intensity can become zero. |
| [SQL sensor summary](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/analytics/models/read_models/activity_sensor_summary_rows.sql) | Drops zero watts before rolling NP and accepts partial initial windows. |
| [TypeScript power analysis](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/training/src/power-analysis.ts) | Preserves zeros and starts NP with full windows, but the legacy power curve uses inferred sample-count windows. |
| [Stress functions](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/training/src/pmc.ts) / [stress class](https://github.com/Asherlc/dofek/blob/17d5b0ab62445b79041e83da077e3a2030158d56/packages/training/src/training-load.ts) | Duplicate TSS, HR stress, regression, and whole-ride FTP formulas. |

## Recommended ownership and unification

Use one pure TypeScript algorithms package, invoked by the serialized application
projector to produce canonical ClickHouse activity metrics and eFTP history.
dbt supplies canonical inputs and downstream projections; TypeScript repositories,
web, mobile, MCP, calendar, PMC and healthspan consume those outputs. This follows
the [analytics build architecture](../analytics/README.md); API requests do not
recompute raw user history.

The sequence is: canonical source selection and elapsed power coverage →
canonical normalized power and dose → ongoing eFTP → activity-applicable
intensity factor and power TSS → serving projections. The package's chronological
recurrence operates over compact activity summaries, never raw sensor arrays
across a user's history; database orchestration remains outside the package.

Keep Critical Power as a separately named performance-analysis result, not an
alternate FTP source. A selected-period CP comparison may legitimately differ
from ongoing eFTP, but it must not secretly control zones or power TSS.

Remove the obsolete TypeScript NP/TSS/FTP production alternatives and the legacy
raw-curve fallback as their consumers move to canonical results. Keep distinct
HR stress/regression algorithms once where still required. Offline TypeScript
reference calibration produces data, not a second ongoing estimator.

An explicit source choice may change which recorded watts are displayed or
classified. It must not create a different ongoing FTP for each provider or
chart filter. The estimate uses canonical deduplicated cycling evidence, with
provider/group/priority changes invalidating that evidence before estimation.

History reconstruction must handle clock progression without uploads,
historical imports, peak-effort corrections/deletions, source changes, and
replay of all affected later estimates. Bound work by dirty users and compact
summary histories; do not introduce checkpoint infrastructure before measured
cardinality requires it. Reuse existing processing contracts and dbt result
evidence so missing downstream metrics cannot be reported as processed.

## Research and implementation status

The user approved implementation and explicitly selected a pure TypeScript,
database-independent algorithms package. The original-source bank and explicit
application policy above are implemented; serving consumers share one numerical
owner. Database orchestration, provenance and wire contracts remain in Dofek.
Implementation verification includes pure numerical regressions, matching
whole-activity/interval coverage, same-day completion admission, historical
replay, revision publication, account-erasure races and fresh/upgrade schemas.
No production deployment is implied by this research record.

Future calibration work should retain frozen manifests, athlete-level splits,
actual long-duration evidence, explicit admission counts, and subgroup/error-tail
reporting. Do not infer sex, fabricate physiological confidence intervals, copy
parameters from ambiguously licensed derivatives, or replace the canonical model
with another formula inside an individual API or client.
