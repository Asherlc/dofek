# Longitudinal Training Analysis MCP Design

## Goal

Extend Dofek's authenticated MCP interface with provenance-rich analytical
primitives that let a reasoning model examine fitness, training load,
progression, recovery, and response to training without downloading every raw
record or guessing through missing data.

The existing high-level MCP tools remain supported. New tools add precise
date-range queries, server-computed longitudinal metrics, compact time-series
access, explicit data-quality evidence, and comparison facilities.

This design builds on Dofek's existing Postgres, Redpanda, ClickHouse, dbt, and
MCP boundaries described in the [repository architecture](../../../README.md),
the [database guide](../../../src/db/README.md), the
[analytics guide](../../../analytics/README.md), and the existing
[MCP data-quality design](./2026-09-01-dofek-mcp-data-quality-design.md).

## Design principles

1. Raw provider records and metric-stream events remain the canonical evidence.
   Derived values are read models or request results, never new raw sources of
   truth.
2. Sensor analytics read `analytics.deduped_sensor`,
   `analytics.deduped_activities`, and their derived activity models. A workout
   represented by Apple Health, WHOOP, Peloton, Strava, Wahoo, or another
   provider contributes once to aggregate activity volume.
3. Expensive standard calculations are materialized incrementally with dbt.
   Explicit, bounded custom-duration requests may execute server-side
   ClickHouse queries, but raw samples are not sent to the model unless it asks
   for a time-series page. dbt incremental models transform selected new or
   changed data rather than rebuilding all history
   ([dbt incremental models](https://docs.getdbt.com/docs/build/incremental-models)).
4. A numeric zero is a value. Missing data is `null`. Interpolated, aggregated,
   calculated, estimated, and inferred results are labeled and never presented
   as direct measurements.
5. FTP-dependent metrics are unavailable when no threshold is valid for the
   activity date. A current FTP with unknown historical validity does not
   silently become the FTP for an old workout.
6. Cardiovascular, climbing, finger, and strength exposure remain separate.
   They may share a calendar row, but they are not added as if their units were
   biologically interchangeable.
7. Correlation-ready output aligns dates and preserves exposure timing. The
   server does not claim that an observed association is causal.
8. Every range tool accepts exact dates and returns the timezone that defined
   its calendar dates. Provider filters, modality filters, pagination, and
   bounded output are applied at the server boundary.

## Existing capabilities retained

The following tools remain available with their current names and core
response shapes:

- `get_daily_health_summary`
- `get_health_trends`
- `get_data_coverage`
- `get_sleep_summary`
- `search_activities`
- `get_activity_summary`
- `get_activity_details`
- `get_activity_streams`
- `get_cycling_performance`
- `get_training_load`
- `get_climbing_sessions`
- `get_finger_loading`
- `get_strength_sessions`
- `get_nutrition_summary`
- `get_body_metrics`
- `get_subjective_timeline`

New fields may be added to these responses where backward-compatible. New
analytical tools are registered separately so existing MCP clients do not need
to adopt the richer contracts immediately.

## Shared evidence contract

New analytical results use a common evidence vocabulary:

```ts
type EpistemicKind =
  | "measured"
  | "provider_recorded"
  | "aggregated"
  | "calculated"
  | "estimated"
  | "interpolated"
  | "inferred"
  | "unknown";

interface SourceReference {
  provider_id: string;
  device_id: string | null;
  source_type: string | null;
  source_record_id: string | null;
  activity_id: string | null;
  member_activity_id: string | null;
  measurement_kind: "direct" | "estimated" | "unknown";
}

interface QualityEvidence {
  status: "high" | "moderate" | "limited" | "unavailable";
  reasons: string[];
  observed_samples?: number;
  expected_samples?: number | null;
  coverage_pct?: number | null;
  largest_gap_seconds?: number | null;
  timezone_assumption?: string | null;
}

interface CalculationEvidence {
  kind: EpistemicKind;
  method: string;
  formula: string | null;
  parameters: Record<string, string | number | boolean | null>;
  assumptions: string[];
}
```

Results also identify canonical activity IDs, duplicate member IDs, source
providers, and the exact activities or observations that contributed. The
contract distinguishes source deduplication from value derivation: a measured
sample selected from overlapping providers remains measured, while the source
selection is separately reported as deduplicated. Activity-level results
include `is_merged_duplicate`, `member_activity_ids`, the source-selection
method, and rejected/absent source references.

Unavailable calculated metrics use:

```ts
{ value: null, reason: "specific missing prerequisite" }
```

The result never substitutes zero or omits the reason.

## Activity time series

Add `get_activity_timeseries` while retaining `get_activity_streams`.

### Input

```ts
{
  activity_id: string;
  streams: Array<
    | "power"
    | "heart_rate"
    | "cadence"
    | "speed"
    | "distance"
    | "altitude"
    | "grade"
    | "position"
    | "temperature"
    | "elapsed_time"
    | "moving_time"
  >;
  resolution?: "raw" | "1s" | "5s" | "10s" | "30s" | "60s";
  fill?: "none" | "linear";
  cursor?: string;
  limit?: number; // default 500, maximum 2,000 synchronized points
}
```

The cursor encodes the authenticated activity, requested shape, resolution, and
next timestamp. It cannot be reused to change the activity or stream set.

### Output

The response is compact and columnar:

```ts
{
  activity: {
    id: string;
    started_at: string;
    ended_at: string | null;
    source_providers: string[];
    member_activity_ids: string[];
    local_time_context: LocalTimeContext;
  };
  resolution: { requested: string; effective_seconds: number | null };
  offsets_seconds: number[];
  timestamps: string[];
  streams: Record<string, {
    values: Array<number | [number, number] | null>;
    states: Array<
      | "measured"
      | "measured_zero"
      | "aggregated"
      | "aggregated_zero"
      | "interpolated"
      | "missing"
    >;
    source_indexes: Array<number[] | null>;
    unit: string;
    summary: {
      min: number | null;
      max: number | null;
      average: number | null;
      observed_samples: number;
      missing_points: number;
      zero_points: number;
      largest_gap_seconds: number | null;
    };
  }>;
  sources: SourceReference[];
  next_cursor: string | null;
}
```

At `raw` resolution, timestamps are the ordered union of requested native
sample timestamps. A stream without a measurement at a timestamp is `null` and
`missing`; it is not forward-filled. At fixed resolution, each bucket contains
the time-weighted mean of observed scalar values, the final cumulative distance
value, or the representative GPS point as appropriate. A bucket composed of
native observations is `aggregated`; an empty bucket remains `missing` unless
the caller explicitly selects linear fill. Linear fill is permitted only
between bounded observations and is labeled `interpolated`.

`elapsed_time` and `moving_time` are server-authored axes. Elapsed time is
derived from the activity start. Moving time is available only where a
provider supplies it or speed/location coverage supports an explicitly labeled
calculation; otherwise its values are null with an availability reason.

Sensor staging retains selected provider ID, device ID, source type, source
record ID, member activity ID, and direct/estimated/unknown measurement kind
through the deduplicated activity sample models. Providers populate the
measurement kind only from explicit source evidence, such as a device-power
flag; otherwise it remains `unknown`. This is provenance propagation, not
another copy of the underlying measurement.

## Power-duration analysis

Add `get_cycling_power_curve`.

### Input

```ts
{
  start_date: string;
  end_date: string;
  durations_seconds?: number[]; // at most 32, each 1 through 21,600
  modalities?: string[];
  providers?: string[];
  include_activity_curve?: boolean;
  cursor?: string;
  limit?: number;
}
```

The default durations are 1, 5, 15, 30, 60, 120, 300, 600, 720, 1,200,
1,800, 2,400, 3,600, and 5,400 seconds.

### Rolling-power semantics

Power is integrated against elapsed time so irregular samples do not become
equally weighted merely because they are rows. A native measured zero
contributes zero energy and remains part of the window. A gap larger than the
documented continuity tolerance invalidates every candidate window crossing
that gap. Boundary energy is evaluated at the requested duration rather than
requiring an exact endpoint timestamp.

The continuity tolerance is returned with each result. It defaults to the
larger of five seconds or twice the activity's median positive sample interval.
The result includes native interval statistics and window coverage so a
five-second Peloton series is not represented as equivalent to native 1 Hz
meter data. A one-second best is unavailable when the source resolution cannot
support it faithfully.

Standard durations are maintained by the incremental
`analytics.activity_power_curve` read model. Custom durations are calculated
server-side from bounded `analytics.activity_sensor_sample` rows and passed as
ClickHouse query parameters; they are not added to a permanent table or
returned as raw samples.

Each best effort includes watts, W/kg, canonical activity ID, date, UTC start
timestamp, start offset, duration, source providers/devices, measured versus
estimated power status, continuity evidence, and the body-weight observation
used.

### Body-weight matching

W/kg uses this deterministic policy:

1. same-local-day directly measured weight;
2. linear interpolation between directly measured weights no more than 14 days
   before and after the effort;
3. nearest directly measured weight within 30 days, preferring the earlier
   observation on an equal-distance tie;
4. unavailable.

The selected method, measurement dates, providers, distance in days, and
quality are returned. Smart-scale body weight is a measured weight. Smart-scale
body-fat or lean-mass values are separately labeled consumer BIA estimates and
are not treated as direct composition measurements.

## Cycling workout analytics

Add `get_cycling_training_metrics` with exact dates, provider/modality filters,
activity pagination, and optional requested best-power durations.

Per activity it returns:

- average and normalized power;
- variability index (`normalized_power / average_power`);
- best powers and W/kg;
- average/maximum heart rate and average cadence;
- mechanical work in kJ from time-integrated power;
- FTP used, its effective date, and provenance;
- intensity factor (`normalized_power / FTP`);
- power TSS (`hours * intensity_factor^2 * 100`), equivalent to the standard
  duration/NP/FTP expression documented by
  [TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071764-Training-Stress-Scores-TSS-Explained);
- power-zone and HR-zone seconds with the exact historical zone inputs;
- aerobic efficiency (`power / heart_rate`) over eligible paired samples;
- first-half versus second-half cardiac decoupling;
- recorded or detected work/recovery intervals.

Normalized power uses 30-second rolling mean power, fourth-power weighting, and
the fourth root, following the method documented by
[TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071804-Normalized-Power).
Windows crossing a discontinuity are excluded. The input is a one-second
time-weighted series, and normalized power is unavailable unless at least 90%
of the activity's moving-time seconds are covered and no retained gap exceeds
ten seconds. The response reports those parameters and actual coverage.

Cardiac decoupling compares the power-to-HR efficiency factor in equal moving-
time halves:

```text
decoupling_pct = 100 * (first_half_efficiency - second_half_efficiency)
                       / first_half_efficiency
```

It requires at least 20 minutes, paired power/HR coverage in both halves, and
reports those coverage thresholds. It is a descriptive within-workout metric,
not a diagnosis or causal statement.

Recorded provider/activity intervals take priority. When no recorded intervals
exist, the server detects inferred work bouts only if effective power
resolution is at most five seconds, total coverage is at least 90%, and no
retained gap exceeds ten seconds. It builds a one-second time-weighted series,
uses a 30-second moving average, and selects a work threshold of 105% of valid
contemporaneous FTP. Without FTP, it uses the activity median plus two median
absolute deviations. A work bout must remain above the threshold for 30
seconds; excursions below it shorter than 15 seconds are merged. Recovery
intervals are the spans between retained work bouts. The response identifies
this detector and every parameter, and assigns limited quality to the
FTP-independent variant. Inferred intervals are never labeled provider
targets. Target and completion fields remain null when target evidence is
absent.

The provider-neutral `activity_interval` record gains optional source identity,
target metric, target minimum/maximum, target unit, and preserved raw evidence.
Peloton class segments and targets are written only when the performance-graph
payload supplies them explicitly. Interval statistics are calculated from
deduplicated sensor samples inside each recorded boundary.

## Threshold history and estimation

Configured sport thresholds and raw provider observations are distinct
concepts:

- `fitness.sport_settings` remains the canonical effective-dated configuration
  used for zones and prescribed thresholds.
- A provider threshold-observation table stores immutable raw evidence with
  sport, threshold type, value, unit, observed/effective timestamp, provider,
  provider record ID, and preserved raw payload. It does not store calculated
  estimates.
- `user_profile.ftp` is reported as legacy current configuration with unknown
  historical validity. It is not silently applied to old activities.

Zwift profile FTP and FIT `threshold_power` are ingested as provider-recorded
observations. Peloton support records only an explicit FTP value returned by an
authenticated Peloton payload; it never derives provider FTP from average
output, leaderboard rank, or class targets. If Peloton does not return an FTP
for the connected account, the endpoint states that no Peloton-recorded value
is available.

Add `get_threshold_history` for configured and provider-recorded observations.
Add `estimate_cycling_threshold` with these selectable methods:

- `best_supported`;
- `recorded_provider`;
- `twenty_minute_95_percent`;
- `sustained_40_to_70_minutes`;
- `critical_power_model`.

The 20-minute method is explicitly labeled an estimate and uses 95% of maximal
20-minute mean power, matching the threshold-testing procedure documented by
[TrainingPeaks](https://help.trainingpeaks.com/hc/en-us/articles/204071934-How-to-Calculate-Threshold-Values-for-Power-Heart-Rate-or-Pace).
The critical-power method fits the two-parameter work-time relationship and
reports its durations, residuals, fit, and extrapolation limitations; the model
originates with Monod and Scherrer
([primary paper](https://doi.org/10.1080/00140136508930810)).

Every result returns estimate, method, confidence, uncertainty or a reason it
cannot be quantified, evidence efforts, relevant activities, date range, and
assumptions. It also returns W/kg with the nearby-weight method and evidence
defined above. `best_supported` uses a documented evidence hierarchy but still
labels calculated values as estimates.

## Longitudinal training load

Extend `get_training_load` compatibly and add a versioned analytical response
selected by `detail: "analytical"`. The exact-range daily rows contain:

```ts
{
  date: string;
  cardiovascular: {
    cycling_power_tss: number | null;
    hr_edwards_trimp: number | null;
    session_rpe_load: number | null;
    coverage: QualityEvidence;
  };
  climbing: {
    session_minutes: number;
    attempts: number | null;
    sends: number;
    high_grade_attempts: number | null;
  };
  finger: {
    time_under_tension_seconds: number;
    effective_load_kg_seconds: number | null;
    high_intensity: boolean | null;
  };
  strength: {
    working_sets: number;
    volume_load_kg: number | null;
    high_rpe_sets: number | null;
  };
  total_daily_load: {
    dimensions: Array<{
      modality: "cardiovascular" | "climbing" | "finger" | "strength";
      method: string;
      value: number | null;
      unit: string;
    }>;
    scalar_value: null;
    reason: "modality-specific loads are not biologically interchangeable";
  };
  rolling: Array<{
    modality: string;
    method: string;
    unit: string;
    acute_7d_sum: number | null;
    chronic_28d_week_equivalent: number | null;
    workload_ratio: number | null;
    monotony_7d: number | null;
    strain_7d: number | null;
    coverage_days: number;
  }>;
}
```

Power TSS is calculated only when contemporaneous FTP and valid normalized
power exist. HR load uses Edwards TRIMP: minutes in five explicitly returned
heart-rate zones multiplied by weights 1 through 5 and summed. It is
unavailable without historical zone boundaries. Session-RPE load is
`duration_minutes * RPE`. TSS, Edwards TRIMP, session-RPE, climbing exposure,
finger load, and strength volume retain different units and parallel series;
none is relabeled to fill a missing value in another series.

`total_daily_load` is therefore a daily vector of named modality-specific
dimensions rather than a scalar. `scalar_value` remains null with the explicit
non-interchangeability reason. This satisfies date alignment without implying
that cardiovascular points, climbing attempts, finger-load seconds, and
strength volume can be added meaningfully.

Each rolling element covers one unchanged modality, method, and unit. Acute
load is the sum of the current and previous six calendar days. Chronic load is
the mean of the current and previous 27 calendar days multiplied by seven.
Ratio is acute over chronic only with all 28 calendar days represented.
Monotony is seven-day mean daily load divided by its population standard
deviation; strain is seven-day load multiplied by monotony. A zero-variance
week has unavailable monotony rather than infinity. These are descriptive
workload statistics and must not be presented as injury-risk diagnoses.

## Climbing progression

Add `get_climbing_progression` with exact dates, discipline, provider,
location, grade-system, pagination, and daily/weekly aggregation.

The activity and entry schema permits `sent` and `attempt_count` to remain null
when a source lacks attempt evidence. Kaya and other importers stop converting
missing attempts to one. A known send without a known attempt count remains a
known send and unknown attempt count; no failed attempts are invented.

The response includes source grades and normalized display grades, discipline,
lead/top-rope state, wall angle, ascent type, location, attempts, sends,
sessions, duration, grade distribution, attempts and send rate by grade,
hardest send, hardest flash/onsight, submaximal volume, frequency, rest days,
consecutive climbing days, and rolling 7/28-day exposure. Any grade-weighted
summary reports its conversion system and is never allowed to erase the source
grade.

Duplicate activity members are resolved through `fitness.v_activity`; entry
deduplication uses stable provider/external IDs when present and reports
ambiguous overlaps instead of silently summing them.

## Finger and hangboard loading

Extend the canonical finger-loading entry only for values that can be recorded
directly: protocol name, repetitions per set, assistance/load direction,
laterality, pain, and existing grip/edge/load/duration/rest/RPE fields. Existing
`set_count` remains sets; it is not reinterpreted as repetitions.

Add `get_finger_loading_progression` with exact dates and protocol/grip filters.
Effective load is:

```text
effective_load_kg = body_weight_kg + added_weight_kg - assistance_kg
```

Time under tension is hang duration multiplied by repetitions and sets when all
three values are known. Effective load exposure is effective load multiplied by
time under tension. Results retain every input term, unit, and formula.

A high-intensity finger-loading day requires an explicit threshold parameter or
a user-recorded protocol classification. The server does not invent one global
injury-risk threshold. Consecutive finger days and combined climbing/finger
exposure days are returned as counts and dates, not medical conclusions.

## Strength progression and quality

Add provider-agnostic raw-source fields to strength sets so imported load,
repetitions, units, and provider record IDs survive normalization. Canonical kg
and repetition fields remain the values used by valid calculations.

Add `get_strength_progression` with exact dates, normalized exercise identity,
provider, set-type, pagination, and daily/weekly aggregation. It returns:

- canonical exercise ID/name and source alias;
- original and normalized set values;
- working/warm-up/drop/failure/rest classification;
- load, reps, RPE, and RIR where recorded;
- Epley e1RM (`weight * (1 + reps / 30)`) with formula identifier;
- volume, load, e1RM, PR, and frequency trends;
- coverage and quality flags.

Quality rules flag impossible or suspicious values without rewriting them.
Examples include non-positive working-set values, implausibly high repetitions
paired with low weight, abrupt field-scale changes, and likely reversed
load/repetition fields. Flags contain rule IDs and evidence. Flagged sets remain
in raw results but are excluded from volume/e1RM/PR aggregates by default;
`include_flagged_in_aggregates` permits an explicit sensitivity query.

## Recovery and training-response series

Add `get_recovery_training_series` with an exact date range, requested fields,
provider/modality filters, and optional nutrition inclusion.

Every local date in the requested range appears exactly once. Each row aligns:

- HRV, resting HR, respiratory rate, and steps;
- sleep duration, efficiency, stages, onset/wake context, and sleep provenance;
- measured body weight and nearby-weight evidence;
- cardiovascular, cycling, climbing, finger, and strength exposure;
- subjective fatigue, soreness, pain, and injury symptoms;
- nutrition energy/macros and completeness state;
- source coverage and timezone assumptions.

Training on date D and recovery measured on D+1 remain separate rows so the
analyst can choose and explain a lag. The server does not calculate or describe
a causal effect.

## Equivalent-performance comparison

Add `compare_performances` with an exact range and a discriminated reference:

- canonical activity ID;
- Peloton workout/class ID;
- cycling route reference activity;
- climbing entry or provider route/problem ID;
- normalized strength exercise ID;
- standardized-test activity name/provider type.

The server returns the equivalence rule, matching evidence, confidence, rejected
near-matches, and comparable observations. Cycling comparisons include power,
HR, cadence, elapsed/moving duration, environment, elevation, and coverage.
Climbing comparisons retain route/problem, grade, discipline, location, and
attempt evidence. Strength comparisons use canonical exercise identity and set
type.

Peloton class ID, stable climb IDs, and canonical exercise IDs are high-confidence
keys. Route comparison uses an explicitly documented GPS similarity result over
distance, start/end proximity, and sampled path similarity; it does not claim
two rides are the same route when coverage is insufficient. Name-based tests
are lower confidence and retain the compared names/provider types.

## Body weight and composition

Extend `get_body_metrics` and analytical responses with rolling means, change,
measurement method, and source quality. Direct scale weight, nearest weight,
and interpolated weight are distinct methods. DEXA composition and
consumer-scale BIA estimates are distinct evidence kinds. Unknown devices or
providers remain `unknown`; they are not promoted to direct composition
measurements by assumption.

## Nutrition completeness

Add canonical daily logging-completeness evidence with four states:

- `complete`;
- `explicitly_partial`;
- `unknown_completeness`;
- `no_logging`.

`no_logging` means no canonical food entries contributed that day.
`unknown_completeness` means food exists without an explicit completeness
record. Calorie totals never determine completeness by threshold. Complete and
partial states require an explicit user or provider record with provenance.
The existing canonical nutrition source-resolution result remains separate, so
a day can simultaneously have unknown completeness and an unambiguous provider
selection.

## Timezone policy

Every activity and sleep result returns the stored local-time context: timezone,
start/end UTC offsets, provenance source, and rejected provider values where
available. MCP schemas accept all canonical sources, including
`gps_timezone`, `home_zone_fallback`, and `unknown`.

Date grouping uses the record's trustworthy local-time context when present and
the request timezone only as an explicitly labeled fallback. Unknown or
conflicting context is not silently rewritten. Existing timestamp instants
remain UTC; timezone work changes calendar projection and evidence, not the
underlying instant. ClickHouse `toTimeZone` changes timezone representation
without changing the instant
([ClickHouse date-time functions](https://clickhouse.com/docs/en/sql-reference/functions/date-time-functions#totimezone)).

## Query and payload constraints

- Exact range tools validate `start_date <= end_date`.
- Raw/detail collections use opaque cursor pagination and deterministic stable
  ordering.
- Default pages contain at most 500 records or synchronized points; hard
  maximum is 2,000.
- Custom power-curve requests accept at most 32 durations.
- Callers select time-series streams; arrays they do not request are omitted.
- Aggregate responses include compact source references and contribution IDs,
  not repeated provider payloads.
- Standard analytics are computed from incremental read models. Request-time
  custom calculations are bounded by authenticated user, date, activity type,
  selected duration count, and query timeout.
- MCP tools remain read-only and require the existing `activity:read`,
  `health:read`, or `nutrition:read` scopes as appropriate.

## Error handling and observability

Invalid ranges, unsupported streams, malformed cursors, inaccessible activity
IDs, and missing analytical stores fail with specific messages. Missing data is
not an exception when the request itself is valid; it produces null values and
availability reasons.

Unexpected MCP and repository failures are reported through the existing
Sentry path with tool name, bounded date range, requested stream/duration count,
and provider/modality filters. Logs do not contain bearer tokens, raw journal
text, full GPS paths, or preserved provider payloads. Prometheus timing and
result-size metrics cover the new high-cost tools.

## Testing strategy

Every behavior is implemented test-first. Pure calculation tests use
hand-derived reference fixtures. Database-semantic behavior runs against real
Postgres or ClickHouse; integration tests do not mock database modules.

Required fixtures cover:

- complete 1 Hz power including measured zeroes;
- irregular power timestamps and boundary interpolation;
- gaps/dropouts that invalidate candidate windows;
- duplicate activities from multiple providers;
- indoor Peloton five-second samples;
- outdoor Wahoo one-second samples;
- HR without power and power without HR;
- missing and nearby body weight;
- changing configured/provider FTP;
- partial, unknown, and absent nutrition logging;
- suspicious `140 reps x 11 lb` strength data with preserved original values;
- missing, fallback, and ambiguous timezone evidence;
- overlapping climbing records and unknown attempts.

Power-duration results are checked against a small independent numerical
integration fixture, not against another call to the production calculator.
Tests prove that measured zeroes reduce rolling power, missing samples do not
become zeroes, and duplicate activities do not double activity or training
volume.

Contract tests call the public MCP route and validate the advertised input and
output schemas. Focused repository tests cover filters, pagination, access
control, and exact activity contribution IDs. Analytics validation includes
SQL lint/policy checks and executable ClickHouse model tests.

## Acceptance verification

After implementation, run the new tools against the authorized current dataset
and capture whether each question is answered strongly, tentatively, or remains
unavailable:

1. best 5/20/30/60-minute cycling power over 90 and 180 days;
2. best-supported current FTP estimate, its evidence, and uncertainty;
3. current FTP in W/kg using an appropriately matched weight;
4. three-to-six-month aerobic cycling performance change;
5. heart-rate change at comparable power;
6. the power-duration curve and evidence about strengths or weaknesses;
7. high-intensity versus endurance cycling exposure;
8. climbing frequency, grade, and attempts before and after the recent
   reduction;
9. consecutive climbing/finger days and high-load finger days;
10. strength progression, maintenance, or decline by exercise;
11. aligned sleep, HRV, resting HR, and training-load change;
12. strong, tentative, and unavailable conclusions with missing-data reasons.

This verification evaluates data access and evidence quality. It does not add
canned coaching recommendations to the MCP.

## Delivery decomposition

The objective spans four independently reviewable subprojects. Each receives a
separate implementation plan and ends in a working backward-compatible commit:

1. **Sensor provenance and cycling primitives:** shared evidence contracts,
   time-series paging/resolution, corrected rolling power, arbitrary durations,
   nearby body weight, and power-curve MCP.
2. **Thresholds, cycling workouts, and load:** provider threshold observations,
   threshold history/estimation, per-ride metrics, intervals, zones, cardiac
   decoupling, and modality-preserving daily load.
3. **Climbing, finger, and strength progression:** unknown-attempt semantics,
   climbing exposure, finger protocols/load, strength source values, anomaly
   flags, e1RM, PRs, and trends.
4. **Aligned response and comparisons:** nutrition completeness, body evidence,
   date-aligned recovery/training series, equivalent-performance comparisons,
   MCP documentation, and current-dataset acceptance verification.

The branch is not considered complete until all four subprojects and the final
verification pass. Each subproject uses migrations and canonical read models
only where its required evidence cannot be represented by existing normalized
data.
