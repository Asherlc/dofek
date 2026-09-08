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
zero. Finger load is `(bodyweight_kg + external_load_kg) × hold_seconds × set_count`, preserving
signed assistance in `external_load_kg`. Strength volume includes non-warmup/non-rest sets only when
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


## Development

```bash
cd packages/server && pnpm dev   # Start the Express server in development mode
pnpm test                        # Run repo-wide Vitest suites from the repo root
pnpm lint                        # Run Biome from the repo root
```

## Production Deployment

The server is packaged as a Docker image (target `server`) and handles both API requests and static asset serving for the SPA.
