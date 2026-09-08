# Dofek Server

The backend API and background job processor for Dofek. Built with Node.js, Express, tRPC, and Drizzle ORM.

## Architecture

- **tRPC API**: The primary interface for both web and mobile clients. Defined in `src/router.ts`.
- **Express Server**: Hosts the tRPC middleware and supplementary REST routes for webhooks, file uploads, and authentication.
- **Maintenance Webhooks**: Includes internal REST endpoints that run background maintenance asynchronously.
- **BullMQ**: Manages distributed background jobs for data synchronization, imports, and exports.
- **Drizzle ORM**: Type-safe database interactions with TimescaleDB.
- **Repositories**: Data access layer encapsulated in `src/repositories/`, abstracting SQL logic.
- **Insights Engine**: Complex data analysis and correlation logic located in `src/insights/`.
- **Machine Learning**: Predictive modeling (e.g., weight prediction, activity features) in `src/ml/`.

## Key Implementation Details

- **Safe SQL**: Uses `executeWithSchema` (in `src/lib/typed-sql.ts`) which combines Drizzle's `sql` template literal with Zod schema validation to ensure runtime type safety and catch schema drift.
- **Caching**: Implements a `queryCache` middleware for tRPC procedures (`src/trpc.ts`), with per-user isolation and configurable TTLs.
- **Nutrition AI Parsing**: `food.analyzeWithAi` estimates one entry, while `food.analyzeItemsWithAi` parses a natural-language meal into multiple itemized entries for client-side logging flows.
- **Food Record Mutations**: [`FoodRecordService`](./src/services/food-record-service.ts) is the single mutation boundary for MCP and future food-record clients. It validates commands, applies account-erasure fencing and optimistic versions, writes the append-only record ledger through [`FoodRecordRepository`](./src/repositories/food-record-repository.ts), and invalidates nutrition caches only after a new committed operation. Callers must not update or delete provider rows directly.
- **Authentication**: Supports session-based auth with cookie-based persistence for web and Bearer tokens for mobile. See `src/auth/` and `src/routes/auth/`.
- **Redis pairing store**: Companion pairing uses Lua scripts over related Redis keys and is intended for the single-node Redis deployment used by Dofek. Redis Cluster requires every key touched by one Lua script to be in the same hash slot; supporting Cluster mode would require redesigning the pairing key names with Redis hash tags. See the Redis Cluster scaling and hash tag documentation: https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/ and https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags.
- **Monitoring**: Integrated with Sentry for error tracking and Prometheus for performance metrics (`src/lib/metrics.ts`).

### Activity training-stress availability contract

`calendar.weekList` owns both Training Stress Score calculation and availability explanations.
Each activity stat is discriminated by `status`: an `available` stat contains its display-ready
`value`, while a `missing` stat contains an actionable `reason` naming the missing duration,
power/functional-threshold-power, or heart-rate/maximum-heart-rate prerequisite. Web and mobile
render this contract without deriving metric availability. The numeric activity `tss` field remains
nullable for consumers that need the score rather than its compact-card presentation.

### Exercise-volume trend evidence contract

`strength.progressiveOverload` is the canonical web and mobile response for exercise-volume
trends. It preserves each recorded week and fits the slope against actual elapsed calendar weeks,
so an unrecorded week is not silently treated as either an adjacent observation or zero volume.
Each result identifies the exercise, observed period, observation count, elapsed-week count,
server-authored neutral interpretation, and the limitation that volume alone cannot identify a
planned deload.

When at least four recorded weeks contain residual variation, the server reports a deterministic
95% residual circular moving-block interval with the recorded week positions held fixed. Otherwise
it reports a specific reason that uncertainty is unavailable. This reflects fixed-regressor
block-bootstrap methods for weakly dependent time-series errors
([Lahiri et al.](https://doi.org/10.1080/01621459.2011.646929)). Clients only render and
unit-format this evidence; they do not calculate slopes, intervals, or interpretations.

### Health-status evidence contract

Health-status values are interpreted only by
[`src/services/health-status.ts`](./src/services/health-status.ts). Each result includes a semantic
`statusToken`, a short `statusLabel`, the exact server-evaluated `evaluationRule`, and a
metric-specific `explanation`. Web and iOS render those fields directly and may map the semantic
token to an icon or color, but they do not infer a classification from the numeric value, baseline,
or deviation. Recovery classifications use the 30-day baseline in `baselineRelative`; its separate
7-day-versus-prior-28-day comparison is context and does not determine the status, as defined by
[`baseline-relative-metrics.ts`](./src/contracts/baseline-relative-metrics.ts).

### Read-only cycle tracking contract

`menstrualCycle.history` and `menstrualCycle.currentPhase` are read-only projections over raw,
provider-attributed menstrual-flow events in `fitness.health_event`. Exact local-calendar-date
duplicates are grouped while retaining every source; starts fewer than 21 days apart suppress the
estimate as conflicting data. Clients render the server-authored phase, availability explanation,
method, uncertainty, and limitation, and direct corrections back to the source provider.

HealthKit menstrual-flow records carry a cycle-start metadata marker, and Apple permits either one
interval for a period or multiple flow samples with the first sample marked as the start
([HealthKit menstrual flow](https://developer.apple.com/documentation/healthkit/hkcategorytypeidentifier/menstrualflow)).
Read authorization is privacy-preserving and does not disclose whether the user denied a specific
type, so an empty response is described neutrally as no readable provider data
([HealthKit authorization](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)).
The API exposes no create, update, or delete procedure for cycle records.

### Correlation evidence contract

Current web and mobile clients use the versioned `correlation.computeV2` endpoint. The endpoint
reports paired-calendar-day coverage, Spearman rho, linear slope/$R^2$, and a 95% circular
moving-block interval; `correlation.compute` remains an exact legacy compatibility projection.
Both endpoints share the source pipeline in
[`correlation-repository.ts`](./src/repositories/correlation-repository.ts).
Both endpoints reject a comparison of a metric with itself. V2 also returns a
server-authored interpretation warning because measurements that persist from one day to the
next or share a time trend can appear strongly related without a direct relationship, the
classic spurious-regression problem described by
[Granger and Newbold (1974)](https://doi.org/10.1016/0304-4076(74)90034-7).

Nutrition inputs come from the canonical `fitness.v_nutrition_daily` available-resolution
rows. Activity-duration inputs come from the deduplicated ClickHouse
`analytics.activity_summary` read model, and its activity date is projected in the user's
timezone before joining. ClickHouse documents `toTimeZone` as changing the displayed
timezone/timezone metadata without changing the underlying point in time
([ClickHouse date-time functions](https://clickhouse.com/docs/en/sql-reference/functions/date-time-functions#totimezone)).
The interval design and primary statistical references are documented in
[`@dofek/stats`](../stats/README.md#dependence-aware-uncertainty).

### Journal trend evidence contract

`journal.trends` is the canonical web and mobile response for journal trend review. It returns an
exact inclusive date window, raw provider-attributed numeric and Yes/No observations, and
server-authored coverage statements. Finite windows include explicit null points for unrecorded
days; the All-history window keeps points sparse and summarizes missing days by count so response
size grows with observations instead of calendar age. The response also explicitly reports that an
uncertainty interval is unavailable for these raw observations. Clients render that evidence
directly and do not infer a directional trend, causal effect, or confidence interval. The contract
and gap construction live in
[`journal-trend-evidence.ts`](./src/services/journal-trend-evidence.ts).

### Estimated strength evidence contract

`strength.estimatedOneRepMax` returns the raw estimated-max observations together with a
server-authored first-to-latest change direction, summary, non-negative kilogram magnitude, and
exact date bounds for each exercise. Web clients may convert the kilogram values into the selected
display unit and format dates, but they render the supplied direction and summary without inferring
a trend from the observations. The responsive chart selects one exercise at a time so long exercise
lists stay readable without hiding the time axis.

### MCP activity and cycling analytics

The read-only MCP keeps the existing `get_activity_streams` and
`get_cycling_performance` contracts and adds bounded analytical primitives. MCP tools publish
input and output schemas so clients can validate calls and structured results
([MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).

`get_activity_timeseries` requires `activity:read`. It accepts selected streams, `raw`, `1s`, `5s`,
`10s`, `30s`, or `60s` resolution, optional linear filling, and a cursor. Raw pages default to 500
timestamps and every page is capped at 2,000. Values, states, and source indexes are parallel arrays:
missing values remain `null`, measured zero remains zero, and measured, aggregated, interpolated,
and missing states are explicit.

`get_cycling_power_curve` also requires `activity:read` and an inclusive `start_date`/`end_date`.
Optional filters are `durations_seconds`, activity `modalities`, and source `providers`. It accepts at
most 32 unique durations from 1 through 21,600 seconds. Defaults are 1, 5, 15, 30, 60, 120, 300,
600, 720, 1,200, 1,800, 2,400, 3,600, and 5,400 seconds. Range bests are always compact;
per-activity rows are returned only with `include_activity_curve: true` and are cursor-paginated with
a default page size of 100 and maximum of 500.

Each effort includes its canonical and merged member activity IDs, UTC start, local activity date,
start offset, power measurement kind, provider/device contributors, sample coverage, median
resolution, largest gap, and continuity tolerance. W/kg is calculated only from a valid directly
measured body weight: the
same local day is preferred, otherwise two measurements within 14 days on both sides are linearly
interpolated, otherwise the nearest measurement within 30 days is used. The complete weight evidence
is returned. When no weight qualifies, both W/kg and the weight value are `null` with an explicit
reason; smart-scale body-composition estimates are not substituted for body weight.

Standard durations read the deduplicated `analytics.activity_power_curve` model. Arbitrary durations
are calculated in one bounded ClickHouse query over deduplicated activity sensor samples, rather than
returning raw samples to the model. Formula and historical-refresh details are documented in
[`analytics/README.md`](../../analytics/README.md#cycling-power-duration-semantics-and-refresh).

`get_threshold_history` requires `activity:read`, an inclusive date range, and optionally provider
filters plus cursor pagination. It keeps three concepts separate: effective-dated cycling FTP from
`fitness.sport_settings`, immutable provider observations, and the legacy current
`user_profile.ftp`. The legacy value has unknown historical validity and is never silently applied
to an old workout. Provider observations include their provider record ID and observation/effective
timestamps. A provider's modeled threshold, such as Zwift zFTP, is labeled `provider_estimated` and
is never represented as measured FTP. Repeated provider syncs append a new observation only when the
reported value, unit, or effective timestamp changes.

`estimate_cycling_threshold` requires `activity:read` and the ClickHouse analytics store. Its
selectable methods are `recorded_provider`, `twenty_minute_95_percent`,
`sustained_40_to_70_minutes`, `critical_power_model`, and `best_supported`. The 20-minute method is
explicitly the 95% heuristic described by
[TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071934-How-to-Calculate-Threshold-Values-for-Power-Heart-Rate-or-Pace).
The critical-power method fits the two-parameter Monod–Scherrer work-time relationship
([Monod and Scherrer](https://doi.org/10.1080/00140136508930810)) over valid 120–600-second range
bests. It returns CP, W′, R², power residuals, and residual RMSE. RMSE describes model fit only; it is
not physiological uncertainty. Every method returns its source efforts and activity IDs,
assumptions, confidence, and either an explicit uncertainty value or a reason one cannot be
quantified. Calculated results have `classification: "estimated"` and are never labeled measured
FTP. W/kg uses body-weight evidence selected for the requested range end date under the same nearby-
weight policy as the power curve.

`get_cycling_training_metrics` requires `activity:read`, an inclusive date range, and the
ClickHouse analytics store. It returns newest-first pages of at most 25 canonical cycling
activities and supports modality/provider filters plus a cursor. Each activity is calculated from
deduplicated power, heart-rate, and cadence samples on the server; raw samples are not copied into
the MCP response. Standard best-power durations may be selected independently, and the default set
runs from 1 second through 120 minutes.

The response labels sample-derived values `calculated_from_samples`, reports per-stream observed,
covered, missing, and measured-zero seconds, and preserves merged activity IDs, providers, devices,
power measurement kinds, timezone evidence, and a longitudinal-comparison quality assessment.
Provider aggregate read-model values remain visible separately and do not override the
sample-derived metrics. Effective-dated `fitness.sport_settings` are resolved independently for
each activity; intensity factor, power TSS, and power zones remain `null` with an explicit reason
when no valid contemporaneous FTP exists. Heart-rate zones follow the same rule for threshold HR.

Recorded interval boundaries from any merged member activity take precedence and exact duplicate
boundaries are consolidated while retaining their member activity IDs. When no recorded boundary
exists, the server may label work and intervening recovery intervals using the documented Dofek
heuristic; inferred intervals never receive invented targets or completion scores. Normalized
power, work, variability index, aerobic efficiency, cardiac drift, TSS, and interval formulas and
coverage prerequisites are documented in
[`@dofek/training`](../training/README.md#cycling-workout-metrics). Normalized power follows the
[TrainingPeaks calculation](https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power).

`get_training_load` preserves its original response when `detail` is omitted. With
`detail: "analytical"`, it returns a complete daily date spine with six independent load channels:
cycling power TSS, threshold-heart-rate weighted zone-minutes, session-RPE minutes, recorded
climbing attempts, effective finger-load kg-seconds, and validated strength kg-reps. It never sums
those units into a total: `total_daily_load.value` is explicitly `null` because cardiovascular,
climbing, finger/tendon, and strength exposures are not biologically interchangeable.

Power TSS is `elapsed_hours × (normalized_power / effective_FTP)² × 100`; FTP is resolved from the
effective-dated history for each ride, and absent FTP or normalized power produces `null`, not zero.
The heart-rate channel sums covered minutes in configured threshold-HR zones multiplied by the
one-based zone number. Its weighting resembles Edwards-style zone load, but it is deliberately
named `heart_rate_zone_load` because Dofek uses the athlete's configured threshold-HR boundaries,
not Edwards' original fixed percentages of maximum HR. Sample spans are capped at ten seconds so
dropouts are not silently treated as continuous exposure.

Session-RPE load is session duration in minutes multiplied by recorded RPE, following Foster's
method ([Foster 1998](https://pubmed.ncbi.nlm.nih.gov/9662690/)). Climbing load uses only recorded
attempt counts; an entry without attempt information is missing rather than a failed attempt or
zero. Finger effective load is `bodyweight_kg + external_load_kg`, preserving signed assistance.
Exact kg-second volume would additionally require `hang_seconds × repetitions × sets`; the
analytical channel returns it as unavailable because the raw schema lacks repetitions per set.
Strength volume includes non-warmup/non-rest sets only when
weight is greater than zero and at most 500 kg and reps are 1–100. Excluded sets remain visible in
coverage and anomaly counts rather than contaminating volume.

Every channel reports source activity IDs/providers, supported versus contributing record counts,
first observed date, and `available`, `partial`, `unavailable`, or `not_observed` state. Dates before
source coverage are `null`; established rest/no-exposure days are measured as zero. Rolling values
are calculated separately per channel: acute load is the complete seven-day sum, chronic load is
the complete 28-day sum divided by four, and workload ratio is acute divided by chronic. Monotony is
the seven-day mean divided by population standard deviation, and strain is the seven-day sum times
monotony, matching the descriptive definitions in Foster's work. Zero variance returns `null`
rather than infinity. These series expose formulas and evidence for analysis; they do not apply
"risk zones" or diagnose injury. ACWR has substantial conceptual and causal limitations
([Impellizzeri et al. 2020](https://pubmed.ncbi.nlm.nih.gov/32502973/)).

`get_recovery_training_series` provides a compact, selected date spine for recovery-response
analysis. Available streams are daily HRV/calculated resting HR/respiratory rate/steps, deduplicated sleep and
stages, reconciled body weight, the six independent analytical load channels, subjective symptoms
and active injuries, relevant canonical activities, and optional canonical nutrition. Missing values
remain null with explicit state. Health source attribution is labeled at daily-row scope; sleep,
weight, load, activity, and nutrition retain their more specific provenance and quality fields.
Sleep includes onset/wake timestamps. Weight distinguishes direct daily observations from nearby
measured/interpolated/nearest evidence and includes 7/28-day rolling context. Activity exposure is
a compact canonical daily aggregate with authoritative-versus-assumed date-attribution counts.
Daily activity-ID evidence is capped at 100 with explicit total/truncation metadata. Missing or
invalid activity intervals make duration partial/unavailable rather than zero. Exposure and load
share one source-offset-first calendar projection with an explicit analysis-timezone fallback.

For each response date, `previous_day_training_load` is selected by the preceding local calendar
date, not by subtracting 24 hours, which preserves next-day alignment across daylight-saving changes.
Daily fatigue is returned as unavailable because it is not recorded in the canonical subjective
schema. Stream selection keeps payloads focused and responses are capped at 366 inclusive days. The
endpoint exposes aligned observations only and explicitly does not claim causal relationships from
correlations.
Provider and modality filters apply to activity exposure and all load channels. Authorization and
ClickHouse requirements are evaluated from the selected streams, so Postgres-only subjective or
nutrition requests do not acquire unrelated health/activity dependencies.
Recovery explicitly selects source-context activity dates and every load channel reports
authoritative-versus-analysis-timezone activity counts. The latter identifies activities grouped
by the configured analysis timezone rather than provider/device-local source context. The
standalone analytical training-load tool retains its prior analysis-timezone date policy and
labels it in the returned range.

`compare_performances` performs server-side, equivalence-constrained longitudinal comparisons. A
caller supplies a canonical reference activity, a contracted Peloton class ID, a caller-asserted
provider-scoped cycling route name/provider type, a provider-scoped standardized-test activity
name/provider type, an exact climb composite, a normalized strength exercise ID, or asserted exact
activity name. Reference-based matching refuses ambiguous activities rather than falling back to
sport/duration similarity. Automatic reference derivation is limited to contracted Peloton class
IDs, exact climb composites including lead/top-rope state when recorded, and a single normalized
strength exercise. Canonical Postgres activities prevent provider duplicates from being
counted twice, and cycling metrics come from deduplicated ClickHouse activity summaries. The result
includes candidate-minus-baseline deltas, sample/missingness coverage, deduplicated activity
temperature when observed, source-record-level matching evidence, provider-reported moving-duration
evidence, caller-asserted route context when a provider-scoped cycling name/type key is used,
timezone and source provenance, anomaly-aware strength values, explicit partial climbing
observations, and reference-bound keyset pagination.
Cross-provider duplicate climbing/set records are consolidated; conflicting records are excluded
and surfaced rather than silently selected. Incomplete climbing observations never produce exact
attempt/send deltas. Strength volume and estimated-1RM values carry complete/partial/unavailable
coverage and produce deltas only when both performances are complete. Fuzzy near matches are
explicitly not evaluated. Exact-name comparisons are labeled as caller assertions, and the tool
does not claim causality. Evidence arrays have explicit caps, total counts, and truncation flags so
large canonical duplicate groups remain token-bounded.
See the [performance comparison repository](src/repositories/performance-comparison-repository.ts)
and its [modality-specific consolidation](src/repositories/performance-comparison-modality-metrics.ts).

`get_climbing_progression` requires `activity:read` and an inclusive date range. It calculates
whole-range daily and grade aggregates while cursor-paginating only the detailed sessions, so an
analyst does not need to fetch every climbing activity individually. Optional provider,
discipline, location, and grade-system filters apply to both aggregates and coverage. The response
includes session frequency, rest and consecutive days, trailing 7/28-day exposure days, grade
distribution, observed send rate, attempts per send, hardest send/flash/onsight evidence, and a
descriptive `volume_below_range_hardest_send` measure. The latter means known attempts on grades
below the hardest observed send in the requested range; it is not presented as physiological
intensity. The server reads the preceding 27 days plus the uninterrupted pre-range streak when
calculating the first returned rolling/streak value; lookback sessions do not leak into requested-
range grade, volume, coverage, or detail totals.

Climbing attempts and outcomes retain three distinct states: a recorded positive/count value, an
observed zero at an aggregate level, or missing source information. A climb with null
`attempt_count` and null `sent` remains null and does not become a failed attempt. Attempt totals
are labeled `complete`, `partial`, or `unavailable`, and send rate uses only entries with an
observed outcome as its denominator. The existing `get_climbing_sessions` tool is preserved and
now uses the same missing-value semantics. Attempts per send is null unless both attempt and outcome
coverage for that grade are complete. Source grade/system values remain intact, while normalized
display grades use Dofek's default V Scale for boulders and YDS for routes. `grade_progression`
returns the hardest observed send for each date and discipline rather than reducing the entire
range to one value.

Canonical activity groups count as one session. Exact matching entry observations from different
member activities/providers are consolidated once while retaining every contributing entry,
activity, and provider ID. Conflicting cross-provider observations with the same climb identity
remain in session detail, receive a `possible_overlapping_climbing_entries` quality flag, and are
excluded from aggregates rather than being silently reconciled or double-counted. Each session
also returns its stored named timezone or UTC offsets. Calendar dates use authoritative provider,
device, GPS, or home-zone context when available and use the user's analysis timezone only when
the source context is unknown. The versioned session cursor is bound to the user, exact request
filters, date range, and normalized-grade preference and uses keyset comparison, so malformed or
mismatched cursors fail and deletion of the prior cursor row does not lose subsequent sessions.

`get_finger_loading_progression` requires `activity:read` and an inclusive date range. Optional
provider and protocol filters apply to both coverage and results; detailed sessions use a
versioned, request-bound keyset cursor while daily and whole-range aggregates remain complete.
Every entry returns the recorded protocol, grip, edge, signed external load, body weight,
laterality, sets, hang/rest durations, RPE, notes, and source activity/provider evidence. Positive
external load is separately labeled added weight, negative external load is separately labeled
assistance, and effective load remains the transparent calculation
`bodyweight_kg + original_external_load_kg`.

Repetitions within each set are `null` with `not_recorded_by_canonical_schema`, because the current
raw entry schema does not contain that observation. Consequently, exact time under tension and
kg-second exposure are also `null` with an explicit reason rather than silently assuming one
repetition per set. Exact matching entries on different provider members of one canonical activity
are consolidated while retaining every contributing entry, activity, and provider ID. Conflicting
cross-provider entries with the same protocol/grip/edge/laterality identity remain in detail, are
flagged, and are excluded from load and high-intensity aggregates. Dates use the same stored named-
timezone/UTC-offset precedence as climbing progression, and unknown source time context is
explicitly flagged as assumed from the user's analysis timezone.

Pain is likewise returned as `null` with `not_recorded_by_canonical_schema`; free-text notes are
preserved but are not reclassified as pain observations. Entry provenance lists source-recorded
and server-calculated fields separately so body weight or protocol input is not mislabeled as a
server calculation, and derived load values are not mislabeled as source measurements.

High-intensity classification is unavailable unless the caller supplies at least one effective-
load, load-to-bodyweight, or RPE threshold. With thresholds, an entry matches when it meets any
configured threshold, and the response echoes the thresholds used. Consecutive exposure-day counts
are descriptive only. A separate calendar-day union reports climbing-or-finger exposure and its
consecutive-day streak without combining their numeric loads. Each component and the union use
`observed`, `not_observed`, or `unavailable`; confirmed absence and numeric streaks begin only when
both channels have coverage. Finger loading remains its own channel and is never summed with or
treated as biologically interchangeable with climbing, cycling, or generic strength load.

`get_strength_progression` requires `activity:read` and an inclusive date range. Optional provider
and normalized exercise-ID filters apply to both detail and aggregates. The response returns
canonical exercise identity, ordered set history, set type, warm-up/working classification, load,
repetitions, RPE, duration/distance, notes, frequency, daily maximum load and volume, e1RM observations, and PR
evidence. RIR is `null` with `not_recorded_by_canonical_schema`; it is never inferred from RPE.
Detailed sessions use a request-bound keyset cursor while exercise summaries cover the complete
requested range. PR classification is seeded from anomaly-safe history before `start_date`; each
in-range PR includes the preceding best's value and source evidence rather than treating the first
returned set as an automatic lifetime record.

Strong and WHOOP imports retain each provider's original per-set JSON alongside normalized values.
Legacy rows without that evidence report original values as unavailable. Exact normalized set
matches from distinct members of one canonical activity are consolidated once while all
source set/activity/provider records remain listed. Conflicting overlapping sets remain visible,
are flagged, and are excluded from aggregates rather than silently reconciled.

Set volume is `weight_kg × repetitions`. Estimated 1RM uses the named Epley formula
`weight_kg × (1 + repetitions / 30)`, one of the prediction equations evaluated by
[LeSuer et al. (1997)](https://doi.org/10.1519/00124278-199711000-00001). Dofek applies it only to
unflagged working sets of 1–12 repetitions. Warm-ups,
rests, missing load/repetitions, and suspicious records do not contribute to volume/e1RM/PRs.
Records with negative values, more than 100 repetitions, load above 500 kg, RPE outside 0–10, or a
high-repetition/low-load pattern consistent with reversed fields or import corruption remain
unchanged in detail with quality flags. These bounds are validation policy, not silent corrections
or claims that a set is physiologically impossible.

`get_body_metrics` reconciles weight, body-fat percentage, and BMI independently by configured body
source priority and retains all provider-attributed observations. A finite positive body weight is
labeled direct. The current canonical sample does not retain composition measurement method, so
body-fat values remain `unknown` and derived lean mass is
`calculated_from_unknown_composition`; DEXA and consumer BIA are not conflated by assumption. Invalid
weights remain in provenance but cannot win reconciliation or enter rolling calculations. Each returned measurement date includes trailing 7- and 28-calendar-day arithmetic
means over observed daily direct weights and the observation count for each window. Missing days are
not interpolated or converted to zero. Cycling W/kg calculations continue to use the shared nearby-
weight policy: same-day direct weight, bounded 14-day interpolation, or nearest direct weight within
30 days, with the chosen evidence returned to the caller.

`get_nutrition_summary` returns a complete requested date spine. Logged days are
`unknown_completeness` because no connected source currently supplies an explicit daily complete or
partial observation; no-log days are `no_logging`. Energy and macros remain null on no-log days, so a sparse day cannot be mistaken for a
known deficit and a 150-calorie day is not silently classified as partial. Nutrition source resolution
is reported independently through the canonical `fitness.v_nutrition_daily` contribution set.
Supplement-only nutrient totals remain available but do not count as food logging. Dense nutrition
responses are capped at 366 inclusive days. `get_training_load` with `detail: "analytical"` and
`include_nutrition: true` returns this canonical nutrition spine beside, rather than collapsed into,
the modality-specific load channels and requires both read scopes.


## Development

```bash
cd packages/server && pnpm dev   # Start the Express server in development mode
pnpm test                        # Run repo-wide Vitest suites from the repo root
pnpm lint                        # Run Biome from the repo root
```

## Production Deployment

The server is packaged as a Docker image (target `server`) and handles both API requests and static asset serving for the SPA.
