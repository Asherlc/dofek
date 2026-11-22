# Climbing send probability evaluation

## Outdoor V-scale bouldering

On 2026-11-21, a retrospective pilot evaluated the assigned-grade Bradley–Terry
model on one outdoor V-scale bouldering logbook from the study authors’ New
Zealand data. It used the highest pre-February-2021 count of eligible recorded
attempts among 11 climbers with at least 30 such records and both outcomes.
The pilot kept clean sends and explicit unsuccessful records, required an
exact date and a route ID, restricted grades to V0–V17, and excluded climbs
with conflicting grades anywhere in the retrospective study window. It used
the grade field in the authors’ frozen ascent data and collapsed records to
one binary result per climb-day. The minimum of 30 records comes from the
study configuration.
For V0–V17, the pilot used the V number and centered the initial prior at
V1. This shifts both values by the same constant relative to the study’s
ordered factor indices, preserving their differences.
[Study](https://doi.org/10.1515/jqas-2026-0040) ·
[Pinned data and filtering reference](https://github.com/alexeid/climbing-grades/tree/f4ffdc1efd69882aa55489475202a0b2845d1c4a) ·
[Study configuration](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/config.csv) ·
[Grade encoding](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/grades.R)

The pilot tried six monthly cutoffs from February through July 2021. Only the
March cutoff for the selected climber had later eligible climb-days in its
holdout month. It used 98 earlier climb-days and four CmdStan 2.40.0 chains with
2,000 warmup and 2,000 sampling iterations per chain, seed 1234. The maximum
split R-hat was 1.00239 and there were zero divergences. The model continued
the monthly ability random walk into the held-out month. The baseline was the
same climber’s earlier observed send rate of 79.6%.

Each pilot estimated the slope from its selected logbook. The study’s model
shares a slope across climbers within a cohort. These pilots measure the
single-logbook fit, with the choice to pool evidence still open for a product
evaluation. [Study model code](https://github.com/alexeid/climbing-grades/blob/f4ffdc1efd69882aa55489475202a0b2845d1c4a/R/climbing-stan.R)

| Climb familiarity at cutoff | Days | Observed send rate | Mean model probability | Brier, model / baseline | Log loss, model / baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Familiar | 7 | 57.1% | 55.7% | 0.092 / 0.295 | 0.343 / 0.812 |
| Unfamiliar | 23 | 82.6% | 69.5% | 0.100 / 0.145 | 0.335 / 0.465 |

The 90% posterior intervals for the mean predictions were 18.2–88.0% for
familiar climbs and 36.5–93.5% for unfamiliar climbs. Both scores favored the
model on this holdout, and the unfamiliar group’s mean probability was 13.1
percentage points below its observed send rate. These sample sizes and the
retrospective grade provenance leave calibration and generalization open.

## Outdoor Ewbank sport routes

A second pilot used the same selection rule and date window in the authors’
sport-route cohort, with whole-number Ewbank grades of 16 or above and an
initial prior centered at 18. It selected one of 58 eligible logbooks before
the first cutoff. The study’s sport-route classification came from its route
catalogue. The pilot used records with explicit outcomes and stable grades.
Sport-route evidence from Dofek will separately require the recorded lead
method and sport protection used. [Study data and configuration](https://github.com/alexeid/climbing-grades/tree/f4ffdc1efd69882aa55489475202a0b2845d1c4a)

Each of the six February–July 2021 monthly cutoffs had a holdout. Earlier
climb-days increased from 314 at the first cutoff to 361 at the last. The
maximum split R-hat was 1.00161 across fits, with zero divergences. The table
weights the holdout results by the number of climb-days. Each fold’s baseline
uses its own earlier send rate.

| Climb familiarity at cutoff | Days | Observed send rate | Mean model probability | Brier, model / baseline | Log loss, model / baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Familiar | 9 | 55.6% | 48.0% | 0.148 / 0.279 | 0.458 / 0.760 |
| Unfamiliar | 44 | 70.5% | 73.1% | 0.121 / 0.211 | 0.422 / 0.614 |

The posterior intervals for the mean forecast varied with each fold’s target
mix. For unfamiliar climbs, March’s interval was 33.2–66.9% and June’s was
98.2–99.9%. These intervals describe model uncertainty in the mean forecast.
Dofek’s imported records still need validation with grades captured before the
cutoff, including separate results for supported gym and outdoor contexts.
The pilot scores describe the recorded climb-days. Sends-only logs and
unrecorded failures provide no estimate of the frequency of unsuccessful days.

## Dofek owner history: Kaya indoor V-scale bouldering

On 2026-11-22, a retrospective evaluation used the owner's imported history,
restored from the newest production backup into a throwaway local database with
`infisical run --env=prod -- pnpm climbing:export-from-backup`. Only one
context has eligible climb-days: 163 Kaya indoor bouldering days (125 distinct
climbs, 30 logged on more than one day), 2026-07-06 to 2026-11-22, V0–V5, 49
sends. Grades are current catalogue values (`current_assigned`), so this is
retrospective evidence. No gym sport lead, outdoor, or trad day passed the
eligibility rules. Those contexts remain unavailable.

July and August contain 72 climb-days and no sends; September has 5 of 11. The
cutoffs of 2026-08-01 and 2026-09-01 had no training sends and the model
reported them as unavailable. Whether the earlier days are true failures or
unlabeled sessions has not been established, and the earlier send rate used as
the baseline is biased by them (6% at the October cutoff).

A database comparison (2026-11-22) found that the missing August sends exist.
All 60 August Kaya ascent entries are completed, graded and identified, but have
been marked provider-absent between 2026-10-15 and 2026-11-13, and 9 of 14
September entries between 2026-11-19 and 2026-11-22. The export excludes absent
entries, so those sends are missing from the results above, which are therefore
biased. Why Kaya entries become absent is unresolved. Kaya sync now logs the
fetched ascent count and the entries each snapshot newly marks absent, so the
next sync records whether the API stopped returning them. The cutoff results
should be rerun once that is understood.

Four-chain CmdStan fits (seed 1234) had maximum R-hat 1.0038 and no divergences.

| Cutoff | Cohort | Days | Observed send rate | Mean model probability | Brier, model / baseline | Log loss, model / baseline |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2026-10-01 | Familiar | 6 | 66.7% | 22.8% | 0.358 / 0.590 | 0.946 / 1.894 |
| 2026-10-01 | Unfamiliar | 34 | 61.8% | 29.1% | 0.269 / 0.547 | 0.759 / 1.759 |
| 2026-11-01 | Familiar | 5 | 80.0% | 53.3% | 0.238 / 0.469 | 0.632 / 1.185 |
| 2026-11-01 | Unfamiliar | 35 | 42.9% | 40.2% | 0.164 / 0.279 | 0.492 / 0.764 |

The model scored better than the earlier-rate baseline in every cohort, but the
baseline was weak. At the October cutoff the model under-predicted sends by
about 33 percentage points, which is poor calibration. By November it was within
about 3 points for unfamiliar climbs. Counts are small (5–35 days) and the
intervals are wide, so this does not support exposing probabilities yet.
