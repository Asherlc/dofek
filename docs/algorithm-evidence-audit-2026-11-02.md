# Algorithm evidence audit — 2026-11-02

Code snapshot: `27d358a641c417bbfdcda4ec45a81e669c5fde66` on `glowing-moose`.
This is a dated review of implementation and evidence, not a claim that every
deployed process runs this revision. No product algorithms were changed during
the audit. The separately approved TSS removal has not been implemented.

Follow-up: [TSS empirical evidence review](tss-evidence-review-2026-11-02.md)
examines measured outcomes separately from recognition of a published formula.
The later implementation request changes the TSS direction to replacing the
custom HR fallback; that replacement has not been implemented.

## What the ratings mean

The central distinction is between a published ingredient and a validated
product output. Using HRV, a sigmoid, regression, or an ACSM equation does not
validate a readiness score, biological-age claim, or individualized prescription.

| Rating | Meaning |
| --- | --- |
| **Established** | Recognizable published numerical method, measurement definition, or reference standard. This does not certify our implementation or inputs. |
| **Partial** | Published foundations, but Dofek adds assumptions, proxies, or conditions that the cited evidence does not validate. |
| **Custom** | The exact score, thresholds, or recommendation are Dofek choices; no independent validation was found in the reviewed code or artifacts. This is not proof that no relevant research exists anywhere. |
| **Descriptive** | Arithmetic or a data-processing rule; useful without claiming a physiological mechanism or predicted health outcome. |
| **Experimental** | Research or model code without demonstrated product-level validity; offline tools are explicitly marked. |

“Established” is not synonymous with clinical accuracy. “Custom” is not
synonymous with useless. A transparent descriptive display can be more defensible
than a familiar name applied to a different calculation. Each assessment below
is the auditor's interpretation of the linked code and sources.

| Catalogue classification | Families |
| --- | --- |
| Established method or reference standard | 16 |
| Partial support for our adaptation | 34 |
| Custom rule or score | 38 |
| Descriptive arithmetic or processing | 31 |
| Experimental, including offline ML | 9 |
| Total | 128 |

These counts depend on the chosen family boundaries. They are an inventory
summary, not a percentage of code quality or scientific certainty.

## Coverage and limits

This catalogue inventories **128 algorithm families**, rather than every utility
function. It covers health/recovery/sleep scoring, training and power analytics,
body/nutrition estimates, statistics and recommendations, personalization,
identity/data selection, and offline ML. The review inspected the shared domain
packages, server repositories/routers/services/ML code, current dbt read models,
personalization code, provider HRV handling, and offline Python model code.

Ordinary CRUD, authentication, compression/cryptography, transport retries,
provider field decoding, chart geometry, and generic sorting are outside the
science question. Vendor-produced sleep stages, HRV, body composition, and other
measurements are inputs: this audit does not independently validate vendor
firmware. Repository tests prove specified software behavior, not physiological
validity. No patient cohort, laboratory reference set, or production accuracy
experiment was created for this audit. A source code review cannot establish
empirical accuracy by itself.

“Active path” means referenced by application/server/model code; it does not
prove that every user has data or entitlement for that feature. SQL can be the
active implementation even when a similarly named TypeScript helper has no
production callers. Related wrappers and SQL implementations are grouped below.

## Findings that deserve attention first

1. **Biological-age years are invented units.** `scoreToYearsDelta` is a
   piecewise linear mapping, not a fitted aging or mortality model. There is no
   empirical basis in that implementation for converting 50 score points to
   two or three years. [Code](../packages/scoring/src/healthspan-years.ts).
2. **Healthspan's documentation overstates the implementation.** The scoring
   file says age/gender-adjusted published percentiles, but its functions accept
   neither age nor sex and use hardcoded thresholds. Sleep consistency, steps,
   RHR, lean percentage, and VO₂max are assigned arbitrary points. Associations
   with health do not establish those points or years.
   [Code](../packages/server/src/routers/healthspan-scoring.ts).
3. **Readiness, stress, and strain use custom scales.** Baseline recovery is
   centered at 62 by design; missing components are also replaced with 62.
   These are not recovered WHOOP algorithms. An all-missing component bundle
   evaluates to 62 in the pure scoring functions; upstream endpoint guards can
   prevent some such calls, so this is not a claim that every missing-data screen
   displays 62. [Code](../packages/scoring/src/scoring.ts),
   [weights](../src/personalization/params.ts).
4. **The heart-rate TSS name hides a different algorithm.** Our function
   normalizes average-HR TRIMP at a fixed 0.85 HR-reserve fraction. TrainingPeaks
   documents hrTSS as time in lactate-threshold-relative HR zones; it separately
   describes average-HR TRIMPS TSS. We should not equate our implementation with
   its documented hrTSS. [Code](../packages/training/src/pmc.ts), [source][S1].
5. **“Minetti” is not the published model.** Our factor is `1 + 3.5×grade`
   uphill and `max(0.5, 1 − 1.8×abs(grade))` downhill. It is a Dofek
   approximation, not the paper's walking/running cost curves. The active hiking
   path applies it to route-wide net elevation change/distance, losing the hills
   in a loop with zero net elevation. [Code](../packages/training/src/grade-adjusted-pace.ts),
   [caller](../packages/server/src/repositories/hiking-repository.ts),
   [SQL](../analytics/models/read_models/hiking_activity.sql), [source][S2].
6. **VO₂max has a reserve-conversion mismatch.** Outdoor SQL divides ACSM
   gross oxygen cost by HR-reserve fraction. Under the reserve equivalence
   assumption, the consistent algebra is `(VO₂ − resting VO₂)/fraction + resting
   VO₂`, not `VO₂/fraction`. The code also takes the maximum eligible segment
   estimate. Correcting the algebra would still not validate a wearable VO₂max
   protocol. Cycling uses ordinary best-five-minute power as if it were a
   maximal aerobic test. [SQL](../analytics/models/read_models/activity_vo2max_estimate.sql),
   [helper](../packages/training/src/derived-cardio.ts), [sources][S3], [S4].
7. **Personalization fit statistics are mostly in-sample.** EWMA windows,
   readiness weights, and TRIMP constants are selected on the observations used
   to report their fit. They do not implement retained chronological validation
   in those fitter functions. “Personalized” does not establish a better future
   outcome. [Code](../src/personalization/).
8. **A fitted TRIMP parameter is not identifiable by its objective.** A positive
   multiplicative factor applied to all TRIMP inputs is absorbed by the free
   slope in a regression with intercept, leaving R² unchanged in exact
   arithmetic. `fitTrainingImpulseConstants` nevertheless searches this factor.
   Tiny numerical differences may select an apparent winner. The same factor
   cancels from `computeHrTss`'s numerator and denominator.
   [Fitter](../src/personalization/fit-trimp.ts), [normalization](../packages/training/src/pmc.ts).
9. **Prediction CV is not a prospective forecast test.** Its five contiguous
   test folds train on all other rows, including rows later than the test fold.
   Displayed full-data predictions are in-sample. This is different from
   forward-chaining validation of future predictions. [Code](../packages/server/src/ml/predictor.ts),
   [method guidance][S5].
10. **Statistical confidence and scientific certainty must stay separate.**
    The correlation explorer V2 includes block-bootstrap uncertainty and
    dependence warnings; the insight engine also has ordinary Welch tests,
    rank-correlation p-values, effect-size labels, and overlapping windows.
    Benjamini–Hochberg screening does not fix serial dependence, confounding,
    model search, or causal identification. [Explorer](../packages/server/src/repositories/correlation-repository.ts),
    [insights](../packages/server/src/insights/evidence.ts), [methods][S6], [S7].

## Recovery and baseline algorithms

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| R01 | [Rolling means, SDs and z-scores](../analytics/models/read_models/daily_recovery.sql) | **Descriptive** | Standard baseline arithmetic over upstream rolling windows. A deviation describes recorded history, not a diagnosis or a universal recovery state. |
| R02 | [Z-score → recovery sigmoid](../packages/scoring/src/scoring.ts) | **Custom** | Center 62, steepness 1.1, asymmetric scales 38/62. No calibration of the resulting 0–100 units was found. “Tuned to match Whoop” is a code comment, not validation evidence. |
| R03 | [Composite readiness](../packages/recovery/src/readiness.ts) and [defaults](../src/personalization/params.ts) | **Custom** | Weighted sum: HRV .50, RHR .20, sleep .15, respiration .15 unless fitted. Inputs have research relevance, but these exact weights and score thresholds are not a validated readiness instrument. [HRV study][S8]. |
| R04 | [Missing readiness components](../packages/scoring/src/scoring.ts) | **Custom** | Missing HRV/RHR/respiration/sleep becomes 62 in component construction. This imputes a neutral-looking product score, not observed physiology. |
| R05 | [Daily stress 0–3](../packages/recovery/src/stress.ts) | **Custom** | Thresholded negative HRV, positive RHR and low efficiency add up to 1.5 + 1 + .5. Sharing a vendor's numeric range does not replicate its stress model. |
| R06 | [Weekly stress and trend](../packages/recovery/src/stress.ts) | **Custom** | Arithmetic weekly summaries; “improving/worsening” uses a .3 change between successive groups of seven observations. Meaning inherits the custom stress score. |
| R07 | [HRV rolling coefficient of variation](../packages/server/src/services/mobile-recovery-tab.ts) | **Descriptive** | SD/mean ×100 over seven available HRV rows. With missing dates this is seven observations, not necessarily seven consecutive days. No diagnostic cutoff is established here. |
| R08 | [Apple Health daily HRV selection](../packages/heart-rate-variability/src/heart-rate-variability.ts) | **Partial** | Arithmetic mean of daily samples, including different sampling contexts. A valid average is not proof of a representative resting autonomic measurement. SDNN and RMSSD are different quantities. [HRV standards][S9]. |
| R09 | [Sleep-derived resting HR](../analytics/models/read_models/resting_heart_rate_sleep_window.sql) | **Custom** | Mean of the lowest 10% of sleep HR readings, at least 30 samples. Defensible as a named descriptive statistic; the exact percentile/count are not a validated replacement for every resting-HR protocol. |
| R10 | [Baseline status labels](../packages/server/src/services/health-status.ts) and [readiness gate](../packages/server/src/services/baseline-progress.ts) | **Custom** | Less than 1 SD, 1–2 SD, and ≥2 SD classifications; three recorded observation days plus variation for baseline progress. These are display rules, not clinical reference intervals. |
| R11 | [Anomaly detection](../packages/server/src/repositories/anomaly-detection-repository.ts) | **Partial** | Prior baseline with minimum 14 days; warnings at 2 SD and alerts at 3 SD. Familiar statistical monitoring, but no sensitivity/specificity study for illness or overtraining was found. |
| R12 | [Resting-HR direction](../packages/server/src/services/resting-heart-rate-trend.ts) | **Descriptive** | Compares the last two available seven-day mean values. Up/down is not itself evidence of a meaningful health change. |

## Sleep algorithms

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| S01 | [Sleep duration, stage totals and efficiency](../analytics/models/read_models/daily_sleep.sql) | **Descriptive** | Summaries of source sleep observations and staging availability; efficiency is a duration/time-in-bed statistic. Stage classification accuracy remains a vendor/input question. |
| S02 | [Sleep consistency score](../packages/recovery/src/sleep-consistency.ts) | **Custom** | Mean bedtime/waketime SD mapped from 100 at .5 hours to 0 at 1.5 hours. This is not the published Sleep Regularity Index. [SRI paper][S10]. |
| S03 | [Consistency window and clock handling](../packages/server/src/routers/sleep-need.ts) | **Custom** | Last 14 available schedule rows, minimum seven, ordinary SD of local clock hours. No circular unwrapping in this function: 23:55 and 00:05 look far apart. |
| S04 | [Good-recovery sleep baseline](../packages/server/src/routers/sleep-need.ts) | **Custom** | Mean durations before above-median next-day HRV, ≥7 qualifying nights in 90 days; otherwise 480 minutes. Association-based selection does not identify individual sleep need. [Sleep consensus][S11]. |
| S05 | [Sleep debt and total need](../packages/server/src/routers/sleep-need.ts), [composition](../packages/server/src/contracts/sleep-need-contract.ts) | **Custom** | Baseline + up to 60 extra minutes from yesterday's load/5 + 25% of positive deficits over recent 14 observed nights. Exact repayment fraction and load conversion are unvalidated here; comments calling it WHOOP's formula are unsupported by implementation provenance. |
| S06 | [Sleep-performance target](../packages/server/src/routers/sleep-need.ts) | **Custom** | Performance endpoint uses mean previous recorded sleep duration, or eight hours, rather than the separate sleep-need algorithm. A person's usual duration need not equal their physiological requirement. |
| S07 | [Sleep-performance score](../packages/scoring/src/sleep-performance.ts) | **Custom** | 70% sufficiency +30% efficiency, switching to equal-weight available components when consistency/stress is present. Score meaning changes with available data. No validation for exact weights or tiers found. |
| S08 | [Low-stress sleep component](../packages/server/src/routers/sleep-need.ts) | **Custom** | `100 − stress/3×100`; reuses the custom daily stress scale rather than a measured sleep-specific stress state. |
| S09 | [Recommended bedtime](../packages/scoring/src/sleep-performance.ts), [caller](../packages/server/src/routers/sleep-need.ts) | **Descriptive** | Wake time minus target duration minus 15-minute latency. Active caller uses 07:00. Scheduling arithmetic is valid; a fixed wake time/latency is not individualized circadian modeling. |

## Healthspan and longevity algorithms

The following point mappings are all product rules. Population recommendations
or associations cited in this section do not validate the resulting score or
biological-age units.

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| H01 | [Sleep-consistency points](../packages/server/src/routers/healthspan-scoring.ts) | **Custom** | `100 − bedtime_SD_minutes/90×100`, clamped. Different from the recovery consistency algorithm; no age/sex adjustment. Comment mentioning <30 min =100 disagrees with the actual linear formula. |
| H02 | [Sleep-duration points](../packages/server/src/routers/healthspan-scoring.ts) | **Partial** | Seven–nine hours gets 100; other bins get 70/80/40/20. Adult sleep evidence supports adequate duration, not these points or a universal penalty for >9 h. [AASM/SRS][S11]. |
| H03 | [Aerobic-minutes points](../packages/server/src/routers/healthspan-scoring.ts) | **Partial** | WHO-inspired 150–300 min anchors, converted to custom piecewise points; counts chosen HR zones. Moderate-intensity recommendations do not validate all zones 1–3 as equivalent. [WHO][S12]. |
| H04 | [High-intensity-minutes points](../packages/server/src/routers/healthspan-scoring.ts) | **Partial** | WHO-inspired 75–150 min anchors and custom 0–100 interpolation over zones 4–5. The published guideline allows moderate/vigorous equivalents, not a requirement to maximize two separate scores. [WHO][S12]. |
| H05 | [Strength-frequency points](../packages/server/src/routers/healthspan-scoring.ts) | **Partial** | Two–five sessions =100; ≥1 outside that interval =70. General strengthening-frequency guidance exists, but neither session count equivalence nor these cutoffs is established by it. [WHO][S12]. |
| H06 | [Daily-step points](../packages/server/src/routers/healthspan-scoring.ts) | **Partial** | Fixed 4k/6k/8k/10k bins. Step–mortality associations exist, with age-related differences; this code does not implement an age-specific risk model. [Paluch cohort meta-analysis][S13]. |
| H07 | [VO₂max points](../packages/server/src/routers/healthspan-scoring.ts) | **Custom** | Hardcoded 30/35/40/45/50 cutoffs, no age or sex input. Not published age-adjusted percentiles despite the file header. Inherits estimated-VO₂max limitations. |
| H08 | [Resting-HR points](../packages/server/src/routers/healthspan-scoring.ts) | **Custom** | Every value ≤50 gets100; progressively higher bins get lower points. “Lower is always better” is not established by this implementation; no clinical context or individual validation. |
| H09 | [Lean-percentage points](../packages/server/src/routers/healthspan-scoring.ts) | **Custom** | Points from `100 − body_fat_pct` using sex-neutral 70/75/80/85 cutoffs. This is a body-composition proxy, not a validated longevity model. |
| H10 | [Composite healthspan](../packages/server/src/routers/healthspan.ts) | **Custom** | Equal average of available metric scores after at least three metrics. Different available subsets can yield the same score; no calibrated mortality/aging outcome is fitted. |
| H11 | [Score → years](../packages/scoring/src/healthspan-years.ts) | **Custom** | Exact mapping 0→+3 years, 50→0, 100→−2. Highest-priority misleading unit: these are assigned years, not estimated biological age. |
| H12 | [Healthspan history and trend](../packages/server/src/routers/healthspan.ts) | **Custom** | Historical score uses only RHR, steps, VO₂max; missing components score 50. Current composite can use nine metrics. OLS slope ±.5 points/week defines direction; history and current score are not the same construct. |

## Training load, zones, and recommendations

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| T01 | [Banister-style TRIMP](../packages/training/src/pmc.ts) | **Partial** | Duration ×HR-reserve fraction ×.64×exp(1.92×fraction). Recognizable published formula; common sex-specific defaults and average-HR limitations matter. Dofek's default is not universal. [Primary exercise study][S14]. |
| T02 | [Heart-rate TSS fallback](../packages/training/src/pmc.ts), [SQL](../analytics/models/read_models/daily_endurance_load.sql) | **Custom** | TRIMP normalized to one hour at .85 HR reserve. The .85 assumption is not measured lactate threshold; comment says “max HR” incorrectly. Not documented TrainingPeaks hrTSS. [Definitions][S1]. |
| T03 | [Learned TRIMP→power TSS](../packages/training/src/pmc.ts), [application](../packages/server/src/repositories/pmc-training-load-calculator.ts) | **Custom** | Linear fit with intercept; ≥10 paired activities, R²≥.3, positive slope. Predicts an existing computed score, not measured training adaptation. No retained holdout in these functions. |
| T04 | [PMC CTL/ATL/TSB](../packages/server/src/repositories/pmc-chart-calculator.ts) | **Partial** | Exponential smoothing of daily load and chronic–acute difference, default 42/7 days. Recognizable fitness/fatigue model family, but the labels are modeled quantities rather than measured fitness or fatigue. [TrainingPeaks model documentation][S15]. |
| T05 | [Form zones](../packages/scoring/src/scoring.ts) | **Custom** | Thresholds25, 5, −10, −30 with “Optimal”/“High Risk” labels. No individual injury-risk validation found. Conventional chart bands are not clinical thresholds. |
| T06 | [Raw daily activity load](../analytics/models/read_models/daily_activity_load.sql) | **Custom** | Duration×averageHR/activity-maximumHR. Activity peak is not necessarily personal HRmax, making cross-session intensity comparisons inconsistent. No named validated load model matches this exact rule. |
| T07 | [0–21 strain](../packages/scoring/src/scoring.ts) | **Custom** | `min(21, 2.775×ln(1+load))`. Scaling and Light/Moderate/High/All Out labels are product choices, not a replication of WHOOP strain. |
| T08 | [Recent-to-baseline workload ratio](../packages/server/src/services/strain-target-result.ts), [analytical channel](../packages/server/src/repositories/analytical-training-load-repository.ts) | **Descriptive** | Seven-day load versus equivalent seven-day baseline from28 days. Valid as a ratio if completeness is known; not an injury prediction. Separate paths have different coverage handling. [ACWR critique][S16]. |
| T09 | [Training monotony/strain](../analytics/models/read_models/weekly_training_monotony.sql) | **Partial** | Mean daily load/SD, weekly sum×monotony. Recognizable Foster family, but using our load proxy and recording coverage changes interpretation. Zero variance withheld. [Original method][S17]. |
| T10 | [Weekly ramp rate](../analytics/models/read_models/weekly_endurance_ramp_rate.sql) | **Descriptive** | Difference between week-end42 day smoothed load values. Meaning inherits custom HR-load units; no universal safe/unsafe ramp-rate threshold established here. |
| T11 | [HR-zone load](../packages/server/src/repositories/analytical-training-load-repository.ts) | **Partial** | Covered minutes×one-based configured HR-zone number. Zone-weighted loading is established in concept; these user-configured threshold zones need not reproduce a named protocol's exact boundaries. |
| T12 | [Session-RPE load](../packages/server/src/repositories/analytical-training-load-repository.ts) | **Established** | Recorded session RPE×duration. Published method, conditional on appropriate RPE scale, timing and duration provenance; not interchangeable with power TSS or kilograms. [Foster2001][S18]. |
| T13 | [HR-reserve zones](../packages/zones/src/zones.ts) | **Partial** | Karvonen arithmetic with fixed50–60–70–80–90–100% reserve bands. HR reserve has a published foundation, but universal zone boundaries and physiological zone names are not individualized thresholds. [Karvonen][S19]. |
| T14 | [FTP power zones](../packages/zones/src/zones.ts) | **Partial** | Conventional seven FTP-relative bands. Standard training convention; depends strongly on whether configured/estimated FTP represents the individual. [Coggan][S20]. |
| T15 | [Polarization index](../packages/zones/src/zones.ts), [distribution](../packages/training/src/training-distribution.ts) | **Partial** | Implements Treff's log formula and descriptive2.0 heuristic, with zero-zone restrictions. Physiological three-zone classification is not established merely by using HRR bins; not an optimality or health score. [Treff][S21]. |
| T16 | [Daily strain target](../packages/scoring/src/strain-target.ts) | **Custom** | Readiness≥70→14–18, 50–69→10–14, below50→4–10; linear within bands. No outcome trial for these targets found. |
| T17 | [Today Plan](../packages/scoring/src/today-plan.ts) | **Custom** | Deterministic presentation of the strain target and available supporting facts. Suggested action inherits readiness/strain assumptions; extra supporting facts do not establish causal tailoring. |
| T18 | [Next-workout selector](../packages/training/src/workout-recommendation.ts), [server variant](../packages/server/src/repositories/training-recommendation.ts) | **Custom** | Rest/easy/intense gates, 48h muscle freshness, 2 day HIIT spacing, ≤3 HIIT/week and20%hard-time rule. Broad training ideas have evidence; this exact multi-rule prescription and readiness cutoffs do not. |
| T19 | [Norwegian 4×4 template](../packages/training/src/workout-recommendation.ts) | **Partial** | Four4 min efforts with3 min rests are research-backed in studied populations. Mapping “hard” to generic zone 4 HR reserve and deciding who should do it are separate Dofek assumptions. [Helgerud trial][S22]. |
| T20 | [30/30 interval template](../packages/training/src/workout-recommendation.ts) | **Partial** |30s work/rest resembles studied Billat intervals, but the study specified velocities relative to vVO₂max. Generic zone 5, 20 repetitions and our selection gates are not a direct reproduction. [Billat][S23]. |

## Cycling, running, hiking, and sensor-derived estimates

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| C01 | [One-second signal resampling](../packages/cycling-power/src/resample-signal.ts), [policy](../src/analytics/cycling-power-policy.ts) | **Descriptive** | Elapsed-weighted buckets, explicit null barriers, gap/hold rules. Mathematically useful processing; 5–10s gap limits are engineering policy, not physiological validation. |
| C02 | [Mechanical cycling work](../packages/training/src/cycling-workout-metrics.ts) | **Established** | Integrating watts over seconds gives joules. Coverage remains necessary; mechanical work is not metabolic calorie expenditure. |
| C03 | [Mean-max power](../packages/training/src/power-duration-reference.ts), [SQL](../analytics/models/read_models/activity_power_curve.sql) | **Descriptive** | Best elapsed-time average with continuity checks. A recorded best is evidence of achieved power, not proof of maximal capacity or fitness decline when a later best is lower. |
| C04 | [Normalized power](../packages/cycling-power/src/power.ts) | **Established** | Complete 30-second rolling means, fourth-power mean, fourth root. Matches the published construction; predictive physiological accuracy is a different question. [TrainingPeaks][S24]. |
| C05 | [Intensity factor](../packages/cycling-power/src/power.ts) | **Established** | NP/threshold. Definition is conventional; accuracy depends on both power coverage and threshold estimate. [Coggan][S20]. |
| C06 | [Power TSS](../packages/cycling-power/src/power.ts) | **Established** | Hours×(NP/eFTP)²×100. Published formula; an established formula does not validate Dofek eFTP or universal recovery predictions. [Published definition][S25]. |
| C07 | [Variability index](../packages/training/src/cycling-workout-metrics.ts) | **Descriptive** | NP/mean power. Useful pacing description; no separate fitness diagnosis follows from its numerical value. |
| C08 | [Power:HR aerobic efficiency](../analytics/models/read_models/activity_aerobic_efficiency.sql), [workout version](../packages/training/src/cycling-workout-metrics.ts) | **Partial** | Ratio of paired power/HR, including a zone-filtered SQL path. Temperature, fatigue, hydration and effort affect HR; this is a proxy, not a laboratory efficiency measurement. |
| C09 | [Cardiac drift/decoupling](../packages/training/src/cycling-workout-metrics.ts) | **Partial** | Compares first/second-half power:HR ratios with duration/coverage gates. Descriptive decoupling is useful; these gates and fitness interpretations are not individually calibrated. |
| C10 | [Critical power and W′](../packages/cycling-power/src/critical-power.ts) | **Partial** | OLS of work against time, application120–600s window. Published model family, but ordinary best-effort observations are not automatically exhaustion tests. Work-space R² is not power-space accuracy or confidence. [Monod–Scherrer][S26]. |
| C11 | [Three-parameter reference curve](../packages/cycling-power/src/threshold.ts) | **Partial** | `CP+W′/(duration+tau)` is a published model family. Dofek's population fitting/interpolation and one-hour target are additional choices. [Morton][S27]. |
| C12 | [Computed eFTP reference-bank interpolation](../src/analytics/cycling-power-policy.ts), [bank](../src/analytics/cycling-reference-bank.json) | **Experimental** | Interpolates qualifying3–30 min efforts into modeled60 min power; bank records161 training/51 heldout athletes. Existing evaluation compares recorded power lower bounds, not independently measured physiological FTP. [Local research](cycling-power-algorithms-research.md). |
| C13 | [eFTP history and detraining decay](../packages/cycling-power/src/threshold.ts), [policy](../src/analytics/cycling-power-policy.ts) | **Custom** | Keeps higher candidates and applies up to0.1%daily decline from two14 day dose windows after28 days. Incomplete recorded power withholds decay. Exact coefficient/rule is not physiological validation. [Documented limits](cycling-power-algorithms-research.md#decay-is-a-model-choice-not-a-known-physiological-constant). |
| C14 | [Power dose](../packages/cycling-power/src/power.ts) | **Descriptive** | NP²×seconds; algebraically useful for comparing load windows without eFTP denominator. UnitsW²s are not a measured metabolic dose. |
| C15 | [Cycling VO₂max](../analytics/models/read_models/activity_vo2max_estimate.sql), [helper](../packages/training/src/derived-cardio.ts) | **Partial** | `10.8 × best 5-minute W/kg + 7`. Oxygen-cost equation ancestry does not make a nonmaximal five-minute ride a VO₂max test. TypeScript helper is not the active SQL calculation. [ACSM-context study][S3]. |
| C16 | [Walking/running/hiking VO₂max](../analytics/models/read_models/activity_vo2max_estimate.sql) | **Partial** | ACSM gross oxygen-cost equations, 5-minute segments, HR reserve0.6–1, maximum accepted estimate. Reserve denominator mismatch and broad speed/negative-grade range need review; not a validated submaximal test protocol. [Sources][S3], [S4]. |
| C17 | [“Minetti” grade-adjusted pace](../packages/training/src/grade-adjusted-pace.ts), [hiking model](../analytics/models/read_models/hiking_activity.sql) | **Custom** | Piecewise linear cost factors and route-wide net grade. Does not reproduce published nonlinear walking/running curves or preserve route elevation variation. [Minetti][S2]. |
| C18 | [Pace, speed, W/kg and unit conversions](../packages/server/src/repositories/running-repository.ts), [cycling metrics](../packages/server/src/repositories/cycling-effort-metrics.ts) | **Descriptive** | Ratios/conversions are straightforward; bodyweight timing/interpolation and moving-versus-elapsed duration determine comparability. No new physiological claim is needed. |
| C19 | [Step-derived cadence](../analytics/models/read_models/activity_step_cadence_rows.sql) | **Descriptive** | Step count over eligible time intervals; distinct from directly recorded cadence. Requires interval coverage and compatible activity association. |
| C20 | [GPS distance and elevation gain/loss](../analytics/models/read_models/activity_location_summary_rows.sql), [sensor summary](../analytics/models/read_models/activity_sensor_summary_rows.sql) | **Descriptive** | Geometric accumulation and positive/negative altitude differences. Noise, gaps and selected source affect results; not an independently validated altitude correction. |

## Strength and climbing

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| G01 | [Strength volume](../packages/server/src/repositories/strength-repository.ts), [analytical channel](../packages/server/src/repositories/analytical-training-load-repository.ts) | **Descriptive** | Sum of weight×repetitions for eligible sets. Kg-reps is recorded external volume, not equivalent biological stimulus across exercises, ROM, technique or effort. |
| G02 | [Epley estimated 1RM](../packages/server/src/repositories/strength-progression-repository.ts), [older chart path](../packages/server/src/repositories/strength-repository.ts) | **Partial** | `weight×(1+reps/30)`. Progression path limits1–12 reps and flags; older chart has different admission logic. Nonmaximal ordinary sets need not meet reps-to-fatigue assumptions. At 1 rep the formula returns103.33%of the lifted weight. [Prediction study][S28]. |
| G03 | [Progressive-overload trend](../packages/server/src/repositories/progressive-overload.ts) | **Descriptive** | OLS slope of dated weekly volume with residual moving-block bootstrap. Describes volume progression; it does not prove strength/hypertrophy adaptation or identify planned deloads. [Bootstrap basis][S6]. |
| G04 | [Finger effective load and ratio](../packages/server/src/repositories/finger-loading-progression-repository.ts) | **Descriptive** | Bodyweight+signed external load and ratio to bodyweight. Does not model force distribution, one-arm support or pulley mechanics automatically. |
| G05 | [Finger intensity/consecutive days](../packages/server/src/repositories/finger-loading-progression-repository.ts) | **Custom** | High intensity only against caller-configured cutoffs; consecutive recorded days are counted without injury claims. Kg-seconds withheld while repetitions are missing. No universal tendon-risk classifier. |
| G06 | [Muscle heatmap](../packages/training/src/muscle-groups.ts) | **Custom** | Splits sets equally among mapped anatomical slugs, normalizes to user's largest total. A visualization allocation, not measured muscle recruitment or recovery. |
| G07 | [Climbing counts, send rates and progression](../packages/server/src/services/climbing-strengths.ts), [progression](../packages/server/src/repositories/climbing-grade-progression.ts) | **Descriptive** | Known-result send counts/rates and recorded graded-day counts. Unknown outcomes and identity resolution matter; grades are recorded classifications, not equal-interval performance units. |
| G08 | [Grade-adjusted climbing strengths](../packages/server/src/services/climbing-strength-profile.ts) | **Descriptive** | Observed sends minus expected sends using the observed grade-specific known-outcome rates, divided by known count. Standardization-style arithmetic; “strength” is relative to recorded mix, not latent causal ability. [Standardization guidance][S29]. |
| G09 | [Grade conversion](../packages/training/src/climbing-grades.ts) | **Partial** | Uses grade conversion library/tables and grade ordering. Conventional approximate translation; not proof that different systems or routes represent identical difficulty. |

## Body and nutrition

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| N01 | [Macro energy](../packages/server/src/repositories/macro-nutrition-summary.ts) | **Established** | General4/4/9 kcal/g factors, percentages normalized over those three macros and largest-remainder rounding to100%. General labeling factors, not individual absorption measurements. [Federal labeling rule][S30]. |
| N02 | [Micronutrient reference percentages](../packages/nutrition/src/nutrients.ts), [analytics](../packages/server/src/repositories/nutrition-analytics-repository.ts) | **Partial** | Average logged intake/reference. Catalog has fixed RDA-like values rather than individualized age/sex/pregnancy targets; logged coverage and nutrient forms limit adequacy inference. [NIH reference concepts][S31]. |
| N03 | [FDA Daily Values](../packages/nutrition/src/nutrient-safety.ts) | **Established** | Explicit U.S.adult/age4+labeling reference population and sources. A daily-value percentage is not a diagnosis of deficiency or individual requirement. [FDA][S32]. |
| N04 | [Nutrient upper-limit evaluation](../packages/nutrition/src/nutrient-safety.ts) | **Partial** | Bounded NIH-based adult rules, including supplemental-only scope and form limitations. Stated population/scope matter; lack of a rule is not proof of safety. [NIH fact sheets][S31]. |
| N05 | [Logged calorie target progress](../packages/nutrition/src/selected-date-summary.ts), [nutrition repository](../packages/server/src/repositories/nutrition-repository.ts) | **Descriptive** | Compares logged intake with configured/default target. Correctly distinct from energy expenditure or calorie balance; a default target is product policy. |
| N06 | [Adaptive TDEE](../packages/server/src/repositories/nutrition-analytics-repository.ts) | **Partial** | Mean logged calories minus28 day smoothed-weight change×7700/28; ≥20 usable calorie days. Energy conservation is sound, but fixed tissue energy density, incomplete logging and carried weight trends are assumptions. Range is min/max accepted estimates, not a confidence interval. [Hall][S33]. |
| N07 | [Weight/body-fat smoothing](../packages/server/src/repositories/body-analytics-repository.ts) | **Descriptive** | Linear interpolation between observations thenEWMAα=.1. TrendWeight-style smoothing is useful, not an independently measured fat-loss signal. Interpolated points are labeled. |
| N08 | [Weight/body-fat forecast and goal date](../packages/server/src/repositories/body-analytics-repository.ts) | **Partial** | OLS on recent smoothed observations and linear projection with observation gates. R²describes historical fit, not probability of reaching a goal on a date; long-range weight response is dynamic. [Hall][S33]. |
| N09 | [Implied calorie surplus/deficit](../packages/server/src/repositories/body-analytics-repository.ts) | **Partial** | Weight-trend slope × 7700 kcal/kg. Water, glycogen and composition changes can invalidate short-period energy interpretation. [Hall][S33]. |
| N10 | [Weight variation fences](../packages/server/src/services/body-decision-context.ts) | **Descriptive** | Q1−1.5 IQR, Q3+1.5 IQR of recent residuals; 8 minimum / 30 maximum observations. Tukey-style fences flag variation, not a95%interval or medical abnormality. |
| N11 | [Fat and lean mass](../packages/server/src/repositories/body-analytics-repository.ts) | **Descriptive** | Weight×fat fraction and remainder. Arithmetic valid conditional on source body-fat accuracy; lean mass is not synonymous with muscle mass. |
| N12 | [BMI presentation](../packages/server/src/repositories/body-repository.ts) | **Descriptive** | Reviewed path selects recorded `body_mass_index` from source data; not evidence that we calculate or clinically validate a BMI model here. |

## Statistical analysis and prediction

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| A01 | [Means, medians, quantiles, SD](../packages/server/src/insights/stats.ts) | **Established** | Standard descriptive statistics via maintained numerical libraries plus local helpers. Sample-versus-population SD and missing-data selection still matter. |
| A02 | [Pearson and univariate OLS](../packages/stats/src/correlation.ts) | **Established** | Recognizable correlation and regression. Independence-based p-values in legacy paths should not be read as calibrated evidence for autocorrelated daily health series. |
| A03 | [Spearman correlation](../packages/server/src/insights/stats.ts) | **Established** | Average ranks for ties, then Pearson on ranks; t-style p-values. Coefficient is descriptive; small-sample/tied/dependent data limit significance interpretation. |
| A04 | [Welch two-sample tests](../packages/server/src/insights/stats.ts) | **Established** | Unequal-variance t-statistic and Welch–Satterthwaite df. These tests do not automatically address repeated-person time-series dependence or confounding. [NIST][S34]. |
| A05 | [Cohen's d](../packages/server/src/insights/stats.ts) | **Established** | Pooled-SD standardized mean difference. Conventional effect-size statistic, not a causal effect or automatic real-world importance. |
| A06 | [Benjamini–Hochberg screening](../packages/server/src/insights/stats.ts) | **Established** | Recognizable step-up multiple-test procedure. Control depends on valid p-values and dependence conditions; not a cure for every data-mining issue. [Original paper][S7]. |
| A07 | [Circular moving-block bootstrap](../packages/stats/src/block-bootstrap.ts) | **Established** |95%percentile interval, ceil(n^(1/3))block size, 2,000 valid replicates; missing dates retained by appropriate callers. Block bootstrap has published foundations; chosen tuning is Dofek policy, stationarity assumptions remain. [Künsch][S6]. |
| A08 | [Correlation explorer V2](../packages/server/src/repositories/correlation-repository.ts) | **Partial** | Exact calendar-day lag pairing, coverage, block-bootstrap interval and dependence warning; minimum five pairs. Better uncertainty disclosure, not proof that five pairs establish a reliable relationship. |
| A09 | [Conditional insights](../packages/server/src/insights/engine.ts), [rules](../packages/server/src/insights/conditional-tests.ts) | **Partial** | Observational group means, Welch tests, Cohen'sd, andBHscreening. Behavior cutoffs are hand-authored. Group differences are associations, not evidence that changing behavior causes the outcome. |
| A10 | [Exhaustive discovery and lag rules](../packages/server/src/insights/discovery.ts) | **Custom** | Pair/lag search with manually assigned action/outcome directions and confidence gates. Direction exclusions encode product assumptions, not causal identification. |
| A11 | [Insight confidence labels](../packages/server/src/insights/confidence.ts) | **Custom** | “Strong/emerging/early” based on coefficient/effect size and sample cutoffs. These are not calibrated confidence probabilities or evidence grades. |
| A12 | [Confounder suggestions](../packages/server/src/insights/confounders.ts) | **Custom** | Flags context correlated with both variables, absolute rho ≥ .25 and semantic exclusions. Does not statistically adjust the relationship or rule out unmeasured confounding. |
| A13 | [Monthly/rolling insight inference](../packages/server/src/insights/evidence.ts), [engine](../packages/server/src/insights/engine.ts) | **Partial** | Overlapping30 day summaries create dependence; some rank-inference paths use nonoverlapping representatives. Monthly paths explicitly omit multiple-comparison correction. Do not generalize V2 explorer safeguards to every insight path. |
| A14 | [Multivariate OLS predictor](../packages/server/src/ml/regression.ts) | **Established** | Normal equations with Gaussian elimination, trainingR², adjustedR²and standardized coefficients. Numerical fit is not validated health forecasting; near-collinearity and small samples remain concerns. |
| A15 | [Gradient-boosted trees](../packages/server/src/ml/gradient-boost.ts) | **Established** | Recognizable residual-fitting regression-tree ensemble. Local implementation/hyperparameters require empirical assessment; standard model family alone does not establish predictive utility. [Friedman][S35]. |
| A16 | [Prediction training and CV](../packages/server/src/ml/predictor.ts) | **Partial** | Contiguous5 fold tests use all other folds for training, including future rows; full-data predictions are in-sample. No prospective forecast validation follows. [Time-series guidance][S5]. |
| A17 | [Feature importance](../packages/server/src/ml/regression.ts), [trees](../packages/server/src/ml/gradient-boost.ts) | **Partial** | Absolute standardized OLScoefficients and normalized tree split gains. Describes model behavior, not causal drivers, intervention benefit or stable importance with correlated inputs. |

## Personalization fitters

All five fitters expose useful model evidence, but none should be called
scientifically personalized merely because it optimizes historical fit.

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| P01 | [EWMA-window fitting](../src/personalization/fit-ewma.ts) | **Experimental** | Searches chronic 21–63 days, acute 5–14 days; ≥90 rows; maximizes absolute correlation with next 7-row performance; accepts absolute r ≥ .2. No retained chronological holdout; negative associations can win. “Days” also depends on input calendar completeness. |
| P02 | [Readiness-weight fitting](../src/personalization/fit-readiness-weights.ts) | **Experimental** |5%weight grid, all components≥.05, ≥60 rows, r ≥ .15 against next-day HRVz. Predicting one input's future behavior is not validation of whole-body recovery or training advice. |
| P03 | [Sleep-target fitting](../src/personalization/fit-sleep-target.ts) | **Custom** | Mean duration of ≥14 nights before above-median HRV. Different minimum from the router's sleep-need baseline; no counterfactual optimum or sleep-need validation. |
| P04 | [Stress-threshold fitting](../src/personalization/fit-stress-thresholds.ts) | **Custom** |≥60 days, HRVp10/p30/p60, RHRp90/p70/p40. Percentiles force relative categories; they do not identify independently measured stress states. |
| P05 | [TRIMP-constant fitting](../src/personalization/fit-trimp.ts) | **Experimental** |≥20 activities, R² ≥ .3 after factor/exponent grid search against computed powerTSS. Multiplicative factor cannot be identified by free-slope R²; power TSS is not physiological ground truth despite the input comment. |

## Identity, source selection, and offline ML

These are included for completeness. They should usually be evaluated as
engineering/matching methods rather than described as science-backed health
algorithms.

| ID | Algorithm and code | Evidence assessment | What the implementation actually supports |
| --- | --- | --- | --- |
| I01 | [Activity duplicate matching/groups](../analytics/models/read_models/activity_duplicate_matches.sql), [deduplication](../src/db/dedup.ts) | **Descriptive** | Identity/time/type/provenance rules determine which records represent one occurrence. Correctness needs labeled matching examples, not a physiological paper. No calibrated match probability established here. |
| I02 | [Sensor source resolution](../analytics/models/read_models/deduped_sensor.sql), [activity association](../analytics/models/read_models/activity_sensor_sample.sql) | **Descriptive** | Source priorities, canonical groups and time associations select observations. These choices can change downstream metrics even with identical formulas. |
| I03 | [Nutrition contribution selection](../packages/server/src/repositories/nutrition-source-resolution.ts), [canonical schema](../src/db/schema/nutrition.ts) | **Descriptive** | Prefers eligible itemized/meal/daily sources and reports unresolved overlaps. Data provenance rule, not dietary adequacy evidence. |
| I04 | [Repeated-route geometry](../packages/server/src/repositories/route-equivalence.ts) | **Descriptive** | Haversine/local geometry with 90% overlap, 100 m point tolerance, 250 m endpoints, and 10% distance tolerance. Engineering cutoffs, not calibrated probability that efforts were equally difficult. |
| I05 | [Repeated-effort identity](../packages/server/src/repositories/repeated-effort-identity.ts), [comparison context](../packages/server/src/repositories/performance-comparison-context.ts) | **Descriptive** | Exact namespaced identity, geometry, caller assertions and weak similarities have different evidential strength. Repeated identity does not establish equal weather, terrain state, maximal effort or fitness change. |
| I06 | [Catalogue fuzzy matching](../packages/climbing-catalogue/src/matching.ts) | **Descriptive** | Fuse name search plus identity, location and context gates. Source/reference/corroborated/possible are evidence categories, not calibrated probabilities. [Fuse algorithm documentation][S36]. |
| I07 | [Climbing trait/outcome consolidation](../packages/server/src/services/climbing-catalogue-traits.ts), [strengths](../packages/server/src/services/climbing-strengths.ts) | **Descriptive** | Resolves recorded traits, grades, known outcomes and catalogue evidence. Statistical summaries inherit identity/label quality; deduplication is not validation of inferred traits. |
| M01 | [Fused activity CNN](../packages/ml/src/dofek_ml/training.py) | **Experimental — offline** | Separate metric/device convolution branches and fused classifier; 60-second windows. Random stratified window split, with the test set also used as validation. Does not demonstrate athlete/session-independent field accuracy or deployment as a production classifier. |
| M02 | [Splink record linkage](../packages/ml/src/dofek_ml/matching_splink.py) | **Experimental — offline** | Established probabilistic-linkage library, but local labels, prior and candidate set determine results. Synthetic fixture evaluation is not production calibration. [Splink][S37]. |
| M03 | [Dedupe linkage/active learning](../packages/ml/src/dofek_ml/matching_dedupe.py) | **Experimental — offline** | Established learned matching tooling with reviewed-label workflow. Actual accuracy requires independent representative labels; the tiny example is not that evidence. [Dedupe][S38]. |
| M04 | [Transformer record matching](../packages/ml/src/dofek_ml/matching_transformer.py) | **Experimental — offline** | Fine-tunes text-pair sequence classification; inspired by Ditto, not a reproduction of its published benchmark. Pretrained model existence does not validate local entity matching. [Ditto][S39]. |
| M05 | [HMM map matching](../packages/ml/src/dofek_ml/matching_map.py) | **Experimental — offline** | Leuven distance-based HMM with explicit 100 m search / 20 m noise / lattice width 10 settings. Established approach, but those settings and fixture coverage are not calibrated field confidence. [Leuven][S40]. |

## Numerical spot checks

Executed the actual TypeScript pure functions with `pnpm exec tsx -e` during
this review;no source changes were needed. These are demonstrations of code
behavior and algebra,not physiological experiments.

| Check | Observed result | Interpretation |
| --- | --- | --- |
| All four readiness inputs missing,default weights | Components62/62/62/62; composite62 | Missing component imputation creates a plausible score in the pure model. Endpoint availability guards must be assessed separately. |
| Healthspan score0,50,100 | Years+3, 0, −2 | Confirms assigned scale rather than fitted age. |
|60 min,HR150,max190,rest60,exponent1.92;factor.5vs.8 | hrTSS60.171276541695605vs60.1712765416956 | Multiplicative factor cancels apart from floating-point rounding. |
| OLS withx=[1,2,3,4]scaledby.5or.8,y=[2,5,5,9] | R².8909090909090909vs.8909090909090908 | Demonstrates why free-slope R²cannotidentify the TRIMP multiplicative factor. |
| Running 200 m/min,flat,HR157.5,rest60,max190 | Code VO₂max58 | HR-reserve fraction.75 and gross oxygen cost43.5. Reserve-consistent algebra under assumed equivalence gives(43.5−3.5)/.75+3.5=56.8333. This illustrates a model mismatch,not a validated replacement estimate. |

## Recommended decisions

These are proposals,not changes made by this audit.

| Priority | Decision | Reason |
| --- | --- | --- |
|1| Remove biological-age/year claims pending an independently validated model | Assigned units create the strongest unsupported quantitative health claim. |
|1| Complete the already approved removal of TSS and its dependent features | Includes HRnormalization,learned score bridges,PMC/form advice and dependent recommendation inputs;preserve unrelated raw measurements. |
|1| Correct scientific naming and provenance | Rename custom Minetti approximation,avoid claiming vendor replication,and distinguish published HRR/ACSM/TRIMP ingredients from Dofek adaptations. |
|1| Review VO₂max outputs before interpreting them as fitness measurements | Resolve reserve algebra,valid input domains,selection bias and maximal-effort assumptions;then evaluate against appropriate reference tests. |
|2| Replace unjustified score certainty with transparent observations | Show baseline deviation,coverage,sleep duration,recorded volume and measurement provenance. Custom scores can remain only as explicit product indices if wanted. |
|2| Stop presenting in-sample selection as personalized predictive validation | Use chronological,preferablynested evaluation withheld-out outcomes and predeclared metrics;do not optimize a non-identifiable factor. [Validation guidance][S5]. |
|2| Unify evidence conventions across statistical endpoints | Distinguish coefficient,effect size,uncertainty,multiple-test screening and causal interpretation;keep time-series dependence explicit. |
|3| Give each maintained algorithm a model card | Formula/version,primarysource,exact deviations,inputdomain,missing-data policy,validationtarget,held-outresults and limitations. Existing personalization evidence is a useful starting point. |

## Primary sources

Sources support specific ingredients or limitations;none validates the entire
Dofek product. Repository links above are the evidence for implementation
claims. Links below were looked up/opened during the audit where accessible;
some original DOI pages restrict full text. No inaccessible paper is treated as
proof of exact numerical agreement. Bibliography entries preserve original
source attribution and do not imply an independent systematic literature review.

[S1]: https://help.trainingpeaks.com/hc/en-us/articles/204071944-Training-Stress-Scores-TSS-Explained
[S2]: https://pubmed.ncbi.nlm.nih.gov/12183501/
[S3]: https://pmc.ncbi.nlm.nih.gov/articles/PMC7896743/
[S4]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9048681/
[S5]: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
[S6]: https://doi.org/10.1214/aos/1176347265
[S7]: https://doi.org/10.1111/j.2517-6161.1995.tb02031.x
[S8]: https://pubmed.ncbi.nlm.nih.gov/39935030/
[S9]: https://pubmed.ncbi.nlm.nih.gov/8598068/
[S10]: https://pubmed.ncbi.nlm.nih.gov/28607474/
[S11]: https://pmc.ncbi.nlm.nih.gov/articles/PMC4434546/
[S12]: https://www.who.int/europe/publications/i/item/9789240014886
[S13]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9289978/
[S14]: https://pubmed.ncbi.nlm.nih.gov/12832429/
[S15]: https://www.trainingpeaks.com/learn/articles/what-is-the-performance-management-chart/
[S16]: https://pubmed.ncbi.nlm.nih.gov/32502973/
[S17]: https://pubmed.ncbi.nlm.nih.gov/9662690/
[S18]: https://pubmed.ncbi.nlm.nih.gov/11708692/
[S19]: https://pubmed.ncbi.nlm.nih.gov/13470504/
[S20]: https://www.trainingpeaks.com/learn/articles/normalized-power-intensity-factor-training-stress/
[S21]: https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2019.00707/full
[S22]: https://pubmed.ncbi.nlm.nih.gov/11689745/
[S23]: https://pubmed.ncbi.nlm.nih.gov/10638376/
[S24]: https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power
[S25]: https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/
[S26]: https://doi.org/10.1080/00140136508930810
[S27]: https://pubmed.ncbi.nlm.nih.gov/8854981/
[S28]: https://pmc.ncbi.nlm.nih.gov/articles/PMC11435939/
[S29]: https://fingertips.phe.org.uk/static-reports/public-health-technical-guidance/Standardisation/Overview_standardisation.html
[S30]: https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101/subpart-A/section-101.9
[S31]: https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/
[S32]: https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels
[S33]: https://pmc.ncbi.nlm.nih.gov/articles/PMC3880593/
[S34]: https://www.itl.nist.gov/div898/handbook/eda/section3/eda353.htm
[S35]: https://doi.org/10.1214/aos/1013203451
[S36]: https://www.fusejs.io/fuzzy-search.html
[S37]: https://moj-analytical-services.github.io/splink/topic_guides/training/training_rationale.html
[S38]: https://docs.dedupe.io/en/latest/how-it-works/Matching-records.html
[S39]: https://arxiv.org/abs/2004.00584
[S40]: https://leuvenmapmatching.readthedocs.io/en/latest/usage/introduction.html

## Review retrospective

Tracing SQL and live server callers alongside shared helpers prevented several
incorrect conclusions about which formula actually serves the application.
The principal gap was method provenance and independent validation,not a lack
of software tests. A useful documentation improvement would require each
health-related score to state its exact formula,scientific departures and
validation target next to its implementation. A reusable algorithm-evidence
audit skill could enforce that distinction and check that named methods agree
with their cited sources. No production logs or patient data were required for
this audit;the earlier missing-heart-rate incident remains a separate issue.
