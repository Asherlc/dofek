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
