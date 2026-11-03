# TSS evidence review — 2026-11-02

## Finding

Power-based Training Stress Score has real, limited empirical support as a
training-dose index, particularly for associations with aerobic adaptation in
cyclists. The reviewed studies do not establish a universal conversion from TSS
into individual fatigue, recovery hours, readiness, or injury risk. Evidence for
one formula does not validate another score carrying the same name.

This is a targeted primary-literature review, not a preregistered systematic
review or meta-analysis. Searches covered power TSS, TrainingPeaks hrTSS,
TRIMP, performance, fatigue, recovery and validation, including citation trails.
Original methods and results were prioritized over vendor claims and later
papers' descriptions. Failure to find direct validation is not proof that none
exists. No product algorithms were changed for this review.

## Keep the methods separate

| Method | Definition and evidence boundary |
| --- | --- |
| Power TSS | Duration in hours × (normalized power / FTP)² × 100. A published definition does not validate an estimated FTP or a recovery prediction. [TrainingPeaks definition](https://www.trainingpeaks.com/learn/articles/normalized-power-intensity-factor-training-stress/). |
| Current vendor-described hrTSS | Time in heart-rate zones relative to lactate-threshold HR. TrainingPeaks distinguishes this from average-HR TRIMPS TSS. Its public estimation table does not specify numerical boundaries for every low/high zone subdivision. [Vendor documentation](https://help.trainingpeaks.com/hc/en-us/articles/204071944-Training-Stress-Scores-TSS-Explained), [estimation table](https://www.trainingpeaks.com/learn/articles/estimating-training-stress-score-tss/). |
| Dofek's existing HR fallback | Average-HR Banister-style TRIMP normalized to an assumed threshold at 85% HR reserve. This is a custom normalization, not demonstrated replication of current vendor hrTSS. [Implementation](../packages/training/src/pmc.ts), [code audit](algorithm-evidence-audit-2026-11-02.md). |
| Individualized TRIMP | Uses each athlete's measured HR–lactate relationship. Validation of this laboratory-calibrated method cannot be transferred to generic HR coefficients. [Manzi et al., 2009](https://pubmed.ncbi.nlm.nih.gov/19812506/). |

## Original studies

Correlations below describe associations. They are not individual prediction
accuracy, and a confidence interval crossing zero leaves substantial uncertainty
about the direction and size of the association.

| Study | Design and result | Interpretation and limits |
| --- | --- | --- |
| [Sanders et al., 2017](https://pubmed.ncbi.nlm.nih.gov/28095061/), [full text, Table 2](https://cris.maastrichtuniversity.nl/ws/files/62102783/Hesselink_2017_Methods_of_Monitoring_Training_Load_and_Their_Relationships.pdf) | 15 male competitive cyclists, 10-week preseason; TSS data available for 12. Weekly TSS correlated with improvement in power at 2/4 mmol/L lactate: r=.75/.79, 95% CIs .31–.93/.40–.94. Eight-minute TT improvement: absolute watts r=.41 [−.21,.80], W/kg r=.61 [.06,.88]. | Direct positive outcome evidence, strongest for submaximal aerobic fitness. Small observational sample, broad uncertainty, mainly low-intensity training, FTP estimated from an eight-minute test. No independent forecasting test. |
| [van Erp, Foster & de Koning, 2019](https://research.vu.nl/en/publications/relationship-between-various-training-load-measures-in-elite-cycl/) | 21 professional cyclists, four years, 11,655 sessions. TSS, mechanical work, session RPE and Lucia TRIMP were strongly related, but relationships changed between training, racing and time trials. TSS increased 120% between training and racing versus 67–73% for the other indices. | Evidence of agreement with other load summaries, not direct validation against adaptation or recovery. Different scales are not interchangeable. |
| [Woods et al., 2018](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0191644) | 13 trained male cyclists, six-week overload/recovery study prescribed using TSS. By loading's end, 15-second sprint performance fell about 21.1% and 4-km TT performance about 1.1%. | Measured performance deterioration during increased training is real. Without a competing load prescription or control, this does not establish that TSS measures fatigue accurately or outperforms simpler measures. Energy availability also matters. |
| [Klaris et al., 2024](https://doi.org/10.1111/sms.14699), [institutional record](https://researchprofiles.ku.dk/da/publications/performance-and-fatigue-patterns-in-elite-cyclists-during-6h-of-s/) | 12 national-elite male cyclists, six-hour simulated race with repeated sprints and 5-km TTs. TT power declined from 412±38 to 384±41 W; individual losses were 2–14%. Adding TSS did not significantly improve prediction of individual fatigue patterns. | Direct fatigue outcome, but exploratory small sample and no formal FTP test; the authors qualify the TSS analysis. This is a limitation on fatigue claims, not decisive proof that calibrated TSS cannot help. |
| [Alfonso & Capdevila, 2022](https://doi.org/10.7717/peerj.13094) | Five recreational male cyclists, six weeks, 66 paired training/next-morning observations. Previous-day TSS weakly correlated with next-morning HFnu HRV (r=−.299); association with mood was r=−.091. Multiple regression did not significantly explain morning HRV/mood from training metrics. | Some physiological association, weak recovery-prediction evidence. Very small cohort, repeated observations and multiple comparisons. HRV is one response marker, not a complete recovery criterion. |
| [Ferguson, Paton & Hopkins, 2014](https://jsc-journal.com/index.php/JSC/article/view/97) | 24 competitive cyclists, 6–8 months, 55 time trials and 447 road races. Associations of WKO+ fitness/fatigue/freshness with subsequent competition maximum mean power were unclear; performance variation was approximately ±7.1–14%. | Conference abstract, not a full validation paper. The noisy competition outcome prevents distinguishing a poor model from an unreliable criterion. Its strongly worded title is not decisive disproof. |
| [Cipryan, Laursen & Plews, 2016](https://doi.org/10.1080/17461391.2015.1103317), [full text](https://www.workshopdelutas.com.br/i/artigos/14.pdf) | 12 moderately trained men, crossover running intervals. Reported hrTSS was similar across protocols (21.6/21.0/21.2), with somewhat different HRV recovery. Methods define hrTSS as hours × (average HR / HR at VT2)² × 100. | That is not current vendor-described time-in-zone hrTSS. The study uses a named score; it does not establish predictive calibration for the current algorithm. |
| [Wallace, Slattery & Coutts, 2014](https://pubmed.ncbi.nlm.nih.gov/24104194/), [full text](https://opus.lib.uts.edu.au/bitstream/10453/122356/1/a.pdf) | Seven trained runners, 15 weeks; weekly 1500-m tests. Individually fitted performance-model correlations: “rTSS” .70±.11, TRIMP .65±.13, session RPE .60±.10; differences were not significant (p=.33). Methods identify the running score as Skiba GOVSS. | Retrospective model fit, not independent future prediction; running, not cycling or current hrTSS. The algorithm label must be checked before transferring this evidence. |
| [Manzi et al., 2009](https://pubmed.ncbi.nlm.nih.gov/19812506/) | Eight recreational male runners, eight weeks, individually measured HR–lactate calibration. Individualized TRIMP associated with 5/10-km performance improvements (r=−.77/−.82) and lactate-speed changes. | Promising individualized HR-load evidence, but tiny running sample and no TSS comparison. Does not validate a generic app HR-load formula. |

## The hrTSS citation problem

[Wells et al., 2026](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2026.1798702/full)
describes 34,731 sessions from 95 triathletes and cites Cipryan for HR-based TSS
validity. Checking the original methods reveals the formula mismatch above.
Wells also explicitly states that acute physiological/psychological stress
responses were not measured and treats TSS variants as dose indices.
Its size supports descriptive comparisons, not independent validation of hrTSS.

I found use of HR-derived TSS and related HR-load validation, but no convincing
direct primary validation of the current time-in-threshold-HR-zones
TrainingPeaks algorithm against independent outcomes with reported predictive
errors. This conclusion should be revised if such evidence is located.

## Consequences for Dofek

The following are recommendations from this evidence assessment, not
implemented product decisions:

1. Power TSS is defensible as an estimated cycling load index with visible
   method and threshold provenance. Calling its formula established must not
   imply validated recovery or injury prediction.
2. Replacing our custom fallback with vendor hrTSS could improve consistency
   with that product, but cannot currently be justified as a proven scientific
   upgrade. Do not invent missing vendor details and call the result exact.
3. Keep dose, observed responses and performance separate. A load history is
   different from measured fatigue; these studies do not justify presenting a
   generic TSS-derived value as a measured state or prescription.
4. No reviewed alternative establishes universal superiority. Individualized
   TRIMP is promising with laboratory calibration. The direct cycling comparison
   has overlapping uncertainty; session RPE remains a distinct subjective input,
   not an interchangeable power/HR score.

Funding and commercial-conflict declarations were not retrievable for every
study; this review is not a complete conflict-of-interest audit. Evidence is
dominated by small male endurance cohorts and does not establish validity for
ordinary walking or strength training.

## Research practice to retain

For future algorithm reviews, record the actual formula, population, measured
outcome, uncertainty and whether predictions were tested on unseen data. In this
review, reading original methods exposed both hrTSS and running-score naming
mismatches that summaries alone would have missed.
