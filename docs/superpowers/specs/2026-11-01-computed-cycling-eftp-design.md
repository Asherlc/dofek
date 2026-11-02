# Computed cycling eFTP only

Status: implemented in the working branch; final verification and review in progress.
The user explicitly required a pure TypeScript algorithms package with no database dependency.

## Confirmed product direction

Use computed eFTP as the sole cycling threshold for every user. Remove manual
cycling FTP configuration, including its API inputs, stored values, and serving
contracts. Do not add an FTP settings control, an accept-estimate step, a manual
reset value, or a configured-value fallback. The user explicitly selected this
direction on 2026-11-01 after requesting an Intervals.icu-style estimation process.

The goal is to classify an activity from the available evidence of sustained
capacity, without interpreting an ordinary easy workout or an old effort leaving
a fixed window as an immediate reduction in capacity.

## Approaches and selection

The user selected an ongoing computed estimate inspired by Intervals.icu and
approved an independently documented numerical implementation on 2026-11-01.
They specifically require one unified set of power/FTP algorithms without
disparate sources. A
longer fixed window was discussed but not selected. Configured FTP with a
computed fallback was explicitly rejected. Independent, documented numerical
choices must not be described as reproducing Intervals.icu's exact outputs.

Intervals.icu's developer describes matching a qualifying effort to empirical
reference curves fitted with Morton's three-parameter model, taking modeled
60-minute power as eFTP. This differs from fitting a two-parameter model directly
to the rider's recent duration bests:
[reference-curve explanation](https://forum.intervals.icu/t/ftp-and-cp-interchangeability-some-notes/2665/2).

Their ongoing estimate carries forward when a ride supplies a lower candidate,
increases when a ride supplies a higher candidate, and declines gradually when
training load drops. Selected-period power-page estimates are separate and do
not decay:
[ongoing versus period estimates](https://forum.intervals.icu/t/power-model-now-complete/1680/4).
An earlier explanation compares two weeks of training load with the preceding
two weeks, but does not specify the full decay equation or coefficients:
[published decay description](https://forum.intervals.icu/t/eftp-giving-wrong-results/659/7).

## Intended calculation contract

- One server-owned eFTP calculation supplies activity zones, power-based stress
  and load, threshold-dependent cycling analyses, and the ongoing eFTP trend.
- One analytics implementation also supplies normalized power, intensity factor,
  and power TSS. Consumers read those results; they do not retain their own
  whole-ride, selected-period, or heuristic substitutes for the same metrics.
- Reconstruct the estimate chronologically from canonical, deduplicated cycling
  observations and their activity dates. Upload order must not affect results.
- A completed activity may contribute evidence to its own estimate, but later
  activities must never affect an earlier activity's threshold.
- An easier ride does not directly replace the maintained estimate with its
  lower candidate. Decay is a separately identified model operation.
- Preserve native zero power and reject windows crossing missing-time barriers;
  reuse the current elapsed-time power-curve evidence rather than adding a
  second raw sensor pipeline. Current semantics are documented in the
  [analytics README](../../../analytics/README.md#cycling-power-duration-semantics-and-refresh).
- Return the value, method, contributing effort and duration, evidence date,
  and uncertainty as server-authored response data. Any minimum qualifying
  duration and decay parameters must be documented and validated before use.
- With insufficient evidence, report threshold-dependent values as unavailable
  with a specific explanation. Do not invent a default threshold, copy a manual
  value, or offer a manual-entry remedy. Power charts and other observations
  that do not require a threshold remain useful independently.
- Corrections, deletions, membership changes, and historical imports must
  invalidate the affected estimates through existing analytics lifecycle
  mechanisms. This includes deletion of the effort that established a peak.

Computed eFTP is derived analytics, not new canonical Postgres app state. Reuse
bounded queries over existing duration evidence where practical; any necessary
stored derived projection belongs in ClickHouse with source invalidation, not
in `fitness.user_profile` or another application table. This follows the
[repository storage architecture](../../../README.md#architecture).

## Remove manual configuration completely

The source audit found both `fitness.sport_settings.ftp` and
`fitness.user_profile.ftp`. Remove both as application threshold sources and
remove their schema columns through forward migrations. Keep unrelated sport
settings such as heart-rate and pace thresholds. Preserve opaque upstream raw
payloads as provenance, but never consume their manual FTP as a fallback.

Migrate every current reader in the same change:

- The `sportSettings` router and repository: remove writable and readable manual
  FTP fields while retaining unrelated settings.
- Activity power zones and the legacy `power` API: consume the canonical ongoing
  eFTP rather than an independently hardcoded 90-day fit.
- Cycling performance, advanced analysis, workout metrics, threshold history,
  and analytical training-load repositories: replace configured/legacy threshold
  evidence and separate estimation formulas with computed evidence.
- Calendar activity load and provider-absent calendar paths: remove the profile
  FTP baseline and resolve the estimate applicable to each cycling activity.
- PMC: remove whole-activity-average FTP estimation and the single threshold
  applied to the entire queried history. Consume each activity's applicable
  eFTP and canonical power TSS, including cycling evidence with no heart rate.
- Healthspan power-intensity analytics: replace the profile threshold dependency
  with computed evidence; retain unknown power-intensity coverage as unknown
  rather than manufacturing zero minutes.
- ClickHouse raw-table projections and current views: remove legacy profile FTP
  serving columns and coordinate their CDC schema boundary.
- MCP output schemas, descriptions, exports, documentation, and affected test
  fixtures: describe computed eFTP, not configured or legacy manual FTP.

The relevant source locations include the server's
`cycling-threshold-repository.ts`, `cycling-effort-metrics.ts`,
`cycling-training-metrics-repository.ts`,
`analytical-training-load-repository.ts`, `activity-calendar-entry.ts`, and
`cycling-performance-repository.ts`, plus
`analytics/models/read_models/healthspan_activity_zone_minutes.sql`.

This schema removal must follow the repository's coordinated migration and
rollout procedures so old readers do not run against removed columns. Do not
introduce aliases or a temporary compatibility writer. The
[deployment guide](../../../deploy/README.md#rollback-boundary) defines the
forward-migration and maintenance boundary. Implementation must determine the
exact CDC and database dependency order before generating migrations.

## Web and mobile

Show computed eFTP and its provenance on cycling and activity views. Do not add
manual FTP controls. Distinguish the ongoing eFTP used for metrics from the
selected-period Critical Power fit used to explore recorded performances.
Changing a chart's display range must not change an activity's classification.
Both clients render server-computed metrics and availability reasons.

## Normalized-power prerequisite

The investigation reproduced an independent error in
`activity_sensor_summary_rows.sql`: zero-watt observations are removed before
the rolling normalized-power calculation, and partial initial windows differ
from the shared TypeScript implementation. Correct and execute regression tests
for these semantics before using normalized-power-derived training load to
control eFTP decay. TrainingPeaks describes the
[30-second rolling-average basis](https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power).
The [incident investigation](../../production-incident-baseline.md#follow-up--existing-eftp-calculations-and-evidence-window-failure)
records the reproduction. Historical refreshes require separately bounded
operator execution, not a deploy-time replay.

## Research-backed numerical implementation

The reusable, dependency-free [cycling power package](../../../packages/cycling-power/README.md)
owns normalized power, intensity factor, power TSS, reference-curve interpolation,
chronological carry-forward/decay, Critical Power fitting and regression. It
contains no database clients, SQL, providers, Dofek contracts, calibration data
or application policy. Callers supply reference curves, duration bounds, coverage
policy and decay parameters. CP remains a distinct analysis, never a second FTP.

The application [policy](../../../src/analytics/cycling-power-policy.ts) uses nine
pooled reference curves from a fresh original GoldenCheetah CC0 calibration:
256 selected archives, 252 decoded, 212 eligible athletes, 161 training and 51
held out. Reference fitting uses observed 3–60-minute powers; qualifying runtime
efforts are 3–30 minutes, predicting modeled 60-minute power. Outside-bank inputs
remain unsupported. The [research report](../../cycling-power-algorithms-research.md)
and [frozen manifest](../../cycling-power-source-manifest.json) record provenance
and limitations. Observed long-effort agreement is not physiological FTP validation.

After 28 elapsed calendar days from the first admitted activity, compare completed 14-day dose windows using NP² × seconds.
Maintained/increased load holds the estimate. Reduced load applies at most 0.1%
daily decline, proportional to the load deficit; two empty windows represent
observed inactivity. Unknown power in either window withholds decline. This
is a versioned Dofek heuristic, not an Intervals.icu coefficient or universal
physiological rate. Easier candidates cannot directly lower the maintained value.

Dofek owns the serialized [projector](../../../src/analytics/cycling-power-projector.ts).
It computes at most 100 changed native activity inputs per pass, then replays
compact histories for at most 32 ready users. It alone writes ClickHouse NP and
eFTP projections. dbt supplies canonical inputs before this stage and builds
dependent healthspan models afterward. Processing success and cache warming wait
for all required projection work. No equivalent SQL numerical estimator remains.

Canonical history publication is fenced against incomplete input revisions.
Historical corrections/deletions replay later estimates; date changes advance
inactive users. Source filters never select an alternate FTP. Bounded interval
calculations call the same pure package. Account-erasure fences apply atomically
to projection inserts. Deletion/recompute jobs await the one serialized writer.

## Builder review checkpoint

Initial review identified missing reference provenance, numerical policy and
calculation order. Those decisions are now explicit above. Qualifying effort
evidence is applied chronologically; power dose is threshold-independent, so
load-related decay has no circular FTP dependency. IDs break equal-timestamp
ordering deterministically. Real-engine regressions cover replay, publication,
deletion, version changes, date advancement and erased-user write races.

The user superseded the earlier SQL-kernel proposal by requesting pure TypeScript
with no database dependency. Application orchestration and storage remain outside
the algorithms package. Final whole-branch review checks this boundary explicitly.

## Verification and completion

The implementation plan records test-first work and review checkpoints.
Meaningful fixtures cover: a supported qualifying effort; an easier
ride retaining the maintained estimate; a genuine increase; maintained versus
reduced training; old evidence crossing a display-window boundary; initial
insufficient data; historical imports; corrected/deleted peak evidence; duplicate
sources; zero power; gaps; and activity-date isolation.

Run SQL/model behavior against ClickHouse with minimal fixtures, not SQL-string
assertions. Verify web/mobile threshold labels and unavailable states together.
Do not add tests asserting that deleted manual settings no longer exist; remove
their former tests and let typechecks and affected runtime tests verify consumers.

Completion requires removing every manual FTP writer and reader, one canonical
computed threshold across consumers, coherent historical behavior, real-engine
regressions, relevant unit/mobile checks, and a reviewed migration/refresh plan.
No product behavior has changed as part of this design document.
