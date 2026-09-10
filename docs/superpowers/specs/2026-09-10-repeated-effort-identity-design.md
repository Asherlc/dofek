# Repeated Cycling Effort Identity and Comparison MCP Design

## Goal

Give Dofek MCP analysis agents a provider-agnostic way to discover and compare
repeated efforts across years without treating names, duration, or an ordinary
workout best as proof of physiological equivalence or maximal fitness.

This design extends the existing canonical activity groups, ClickHouse/dbt
analytics boundary, and read-only MCP tools. It does not create a second
activity store or require provider network calls for the initial historical
backfill. The existing architecture and read-model rules are documented in the
[repository README](../../../README.md), [analytics README](../../../analytics/README.md),
and [MCP reference](../../mcp.md).

## Design principles

1. A provider activity instance, a reusable workout/template, a route, a climb,
   a segment, a standardized test, and a user-defined benchmark are different
   concepts and receive different identity kinds. `fitness.activity.external_id`
   remains the provider-instance identifier.
2. Identity evidence is retained at source-member level and projected through
   the stable canonical activity group. Deduplication changes which activity is
   served, not which source evidence is available.
3. Exact and strongly inferred equivalence are discoverable by default. Weak
   name/duration similarity is opt-in and is never labeled as exact.
4. Expensive GPS normalization and comparison are incremental ClickHouse/dbt
   work. MCP request paths read bounded serving models and calculate only
   bounded per-effort metrics.
5. Raw/provider-recorded, measured, calculated, estimated, interpolated, and
   inferred values remain separately labeled. Conflicts are returned rather than
   silently reconciled.
6. A historical best observed during an ordinary workout is a lower bound on
   observed capability, not evidence of physiological maximum. A lower recent
   observed best does not establish decline unless efforts are standardized or
   meaningfully equivalent.

## Existing gaps and reuse

The current `compare_performances` implementation already uses
`fitness.v_activity`, member activity IDs, deduplicated activity sensor models,
historical threshold settings, interval detection, and provenance-rich output.
It currently has three limitations this design resolves:

- reusable workout identity is a Peloton-specific raw-field lookup;
- route comparison is caller-asserted activity-name/provider-type matching;
- there is no server-side discovery tool that selects the strongest repeated
  efforts before comparison.

The existing `get_cycling_training_metrics` calculations are the canonical
source for normalized power, work, variability, drift, zones, interval
boundaries, quality, and historical FTP handling. The new comparison service
will consume or share those calculations rather than implement competing
formulas. This follows the existing server-side metric contract and the
[dbt incremental model boundary](https://docs.getdbt.com/docs/build/incremental-models).

## Identity model

### Source-level identity evidence

Add an incremental ClickHouse/dbt serving model named
`analytics.activity_effort_identity` at source-activity grain. It is derived
from the mirrored raw `activity_source_records` data and contains one current
row per source identity claim:

```ts
type EffortIdentityKind =
  | "provider_workout"
  | "provider_route"
  | "canonical_route"
  | "climb"
  | "segment"
  | "standardized_test"
  | "activity_name"
  | "user_defined_benchmark";

type EquivalenceStrength =
  | "exact"
  | "strong_inferred"
  | "caller_asserted"
  | "weak_similarity";

interface ActivityEffortIdentityRow {
  user_id: string;
  canonical_activity_id: string;
  source_activity_id: string;
  source_provider: string;
  source_external_id: string;
  kind: EffortIdentityKind;
  namespace: string | null;
  value: string;
  normalized_value: string;
  display_name: string | null;
  strength: EquivalenceStrength;
  method: string;
  source_field: string | null;
  evidence: Record<string, unknown>;
  source_refreshed_at: string;
  is_deleted: 0 | 1;
}
```

`canonical_activity_id` is the persisted activity-group UUID, while
`source_activity_id` identifies the contributing provider record. Provider
instance identity is represented by `(source_provider, external_id)` from the
source activity projection and is never placed in `value` as an ambiguous
generic ID.

The model extracts only explicit stable fields already present in stored raw
payloads, using a versioned provider-field mapping. Examples are provider
workout/template/class IDs, provider route/course IDs, segment IDs, and
standardized-test IDs. Exact name matching is stored only as
`activity_name`/`weak_similarity`; it cannot be promoted to an exact identity.
Unknown fields remain in raw provenance and are not guessed into an identity.

### User-defined benchmark groups

Add a small Postgres relational model for durable caller-defined equivalence:

- `fitness.effort_equivalence_group`: user, stable UUID, display name, effort
  kind, notes, created/updated timestamps;
- `fitness.effort_equivalence_group_member`: group, canonical activity-group
  UUID, optional inclusion note, created timestamp.

Membership is an explicit user assertion, not an ingestion deduplication edge.
The MCP comparison/discovery repositories join these groups to canonical
activities and label every result `caller_asserted`. The tables store only the
group assertion and membership, not duplicated activity metrics or raw data.

### Canonical projection

`analytics.activity_effort_identity` is grouped by canonical activity ID only
at query time. A canonical activity can therefore expose all useful identities
from Apple Health, Strava, Garmin, Wahoo, WHOOP, RideWithGPS, Peloton, Zwift,
or any other contributing source. If two members disagree, both rows remain
visible and the tool emits a conflict quality flag. The representative activity
does not erase the non-representative identity evidence.

## Route identity

Add an incremental serving model named
`analytics.activity_route_identity` at canonical-activity grain. It reads the
existing deduplicated location samples and identity evidence and produces:

```ts
interface ActivityRouteIdentity {
  canonical_activity_id: string;
  explicit_provider_route_ids: Array<{
    provider: string;
    value: string;
    source_activity_id: string;
    field: string;
  }>;
  route_fingerprint: string | null;
  direction: "forward" | "reverse" | "unknown";
  point_count: number;
  route_distance_meters: number | null;
  start: { lat: number; lng: number } | null;
  end: { lat: number; lng: number } | null;
  elevation_profile: number[] | null;
  geometry_status: "available" | "partial" | "unavailable";
  quality: {
    coverage_pct: number | null;
    largest_gap_seconds: number | null;
    source_providers: string[];
    source_devices: string[];
  };
}
```

The fingerprint uses a bounded, time-ordered normalized polyline rather than
centroid or activity name. The model preserves direction and a canonical
reverse representation so the comparison layer can report forward, reverse, or
unknown direction. It is a serving identity, not a source of truth for raw GPS.

Route equivalence rules:

- the same provider route/course ID is Level A exact;
- equal canonical fingerprints from valid complete geometry are Level B
  `strong_inferred` unless a provider explicitly defines the route identity;
- geometry matching may produce Level B only when overlap is at least 90%,
  start/end tolerance is at most 250 m, distance differs by at most 10%, and
  elevation-profile similarity is at least 0.85 when both profiles are
  available;
- every inferred match returns overlap percentage, direction, distance
  difference, elevation-profile similarity, start/end tolerance, and confidence;
- incomplete geometry or a merely similar centroid/name never creates a
  repeated-effort group.

The thresholds are constants in the route identity module and are included in
the output method/evidence. They are not caller-tunable in this first version,
which keeps discovery deterministic and avoids an unbounded similarity search.

## Structured workout and interval identity

Extend the existing `activity_interval` schema with nullable provider-neutral
fields for source-supplied structure:

- `source_kind`: `provider_recorded` or `inferred`;
- `segment_type`, `target_intensity`, `target_zone`, `target_cadence_rpm`,
  `target_power_watts`, `target_resistance`, and `work_recovery_kind`;
- `raw` provider evidence;
- source provider and source activity member ID where needed for provenance.

Provider-recorded boundaries and targets take precedence. Actual average power,
normalized power, heart rate, cadence, drift/decoupling, completion, and
coverage are calculated from deduplicated samples at read time using the shared
cycling metrics implementation. If no structure exists, the existing bounded
heuristic may label work/recovery intervals as inferred, but it cannot invent
targets or completion scores. Exact duplicate boundaries from merged members
are consolidated while retaining all source member IDs.

Repeated interval structure is Level B only when the normalized sequence of
recorded intervals (type, duration tolerance, and target fields) matches. Name
or duration alone does not establish structured-workout equivalence.

## MCP tools

### `find_repeated_efforts`

Register a read-only tool requiring `activity:read`:

```ts
interface FindRepeatedEffortsInput {
  start_date: string;
  end_date: string;
  canonical_type?: string;
  providers?: string[];
  modalities?: string[];
  minimum_repetitions?: number; // default 2, maximum 100
  equivalence_strength?: "exact" | "strong" | "caller_asserted" | "weak";
  effort_kind?: EffortIdentityKind;
  cursor?: string;
  limit?: number; // default 25, maximum 100
}
```

The default strength is `strong`, which includes Level A exact and Level B
strongly inferred identities and excludes weak similarity. Results are grouped
by a stable, namespaced effort/equivalence ID and include display name,
provider, modality, expected duration where available, repetition count, first
and last occurrence, canonical activity IDs, provider/source evidence,
strength, assumptions, and quality flags. Pagination is keyset-based and
bounded by the authenticated user, query shape, and identity-group key.

If `equivalence_strength: "weak"` is requested, exact/strong groups remain
clearly separated from name/duration similarity groups. Weak groups are
descriptive candidates and cannot be passed through the comparison service as
exact equivalence without caller assertion.

### `compare_performances`

Replace the Peloton-only input union with a provider-agnostic discriminated
union supporting:

- exact provider workout/template ID;
- exact provider route/course ID;
- canonical route identity or bounded geometry specification;
- segment or climb ID;
- standardized-test ID;
- exact normalized activity name (explicitly weak unless caller asserts it);
- user-defined benchmark group;
- reference activity ID, which resolves the strongest available identity
  evidence on that canonical activity.

Each response returns the selected equivalence kind, identity namespace/value,
strength, basis (`derived`, `explicit`, or `caller_asserted`), method,
assumptions, and per-performance evidence. The comparison remains descriptive;
it never claims causality or fitness decline from a non-maximal effort.

For cycling, the response includes nullable server-computed values where
supported: elapsed and moving duration, distance, average and moving speed,
elevation gain, average/normalized power, work, variability index, average/max
heart rate, cadence, power/HR and speed/HR ratios, vertical speed for climbs,
cardiac drift, power drift at comparable HR, HR drift at comparable power, power
and HR zone time, descriptive best powers with duration and non-maximal label,
nearby body weight, valid W/kg, interval metrics, environment, and complete
sample/source quality. Every metric identifies its value kind and source
provenance.

The comparison must resolve effective-dated FTP independently for each activity.
The legacy current profile FTP is never applied to historical activity metrics;
missing contemporaneous thresholds leave FTP-dependent fields null with a
specific reason. This preserves the existing historical threshold contract.

### `get_effort_trend`

Register a read-only tool requiring `activity:read` with either an effort ID
returned by discovery or the same explicit equivalence specification accepted
by comparison, plus an inclusive date range. It returns chronological
repetitions, the comparable metric bundle, delta to first/previous/best,
rolling descriptive trend, quality, evidence, and caveats. It delegates
identity resolution and metric calculation to the comparison service so the two
tools cannot disagree about what constitutes a repetition.

## Metric and quality contract

The output uses explicit nullable values plus evidence rather than silently
filling missing fields. Cycling quality includes:

- measured/provider-recorded versus calculated/estimated/interpolated/inferred;
- provider, device, power source, and heart-rate source;
- observed sample count, per-stream count, coverage percentage, resolution,
  largest gaps, and missing-data reasons;
- merged-source/member IDs, conflicting values, suspicious HR/power values,
  equipment/calibration changes when available, and route identity method;
- whether intervals were provider-recorded or inferred.

Contextual covariates include body weight, recent and previous-day training
load, sleep/recovery, temperature, altitude, indoor/outdoor, equipment, power
source, and HR source when present. They are labeled context, not causal
explanations. Existing recovery/load tools remain the canonical sources for
those observations.

## Data flow

```text
provider raw activity/member records
        │
        ├── stable identity projection ──> activity_effort_identity
        ├── deduplicated location samples ──> activity_route_identity
        └── persisted activity intervals ──> normalized interval metrics
                         │
                         ▼
                 canonical activity group
                         │
       find_repeated_efforts / compare_performances / get_effort_trend
                         │
                         ▼
              server-computed metrics + evidence
```

No request path scans all raw GPS or downloads raw samples to the analysis
agent. Canonical activity deduplication remains the activity-volume boundary;
sensor deduplication remains the sample-value boundary. The new identity
models preserve provenance across both.

## Historical backfill

Create a TypeScript operator script under `scripts/` that:

1. reads active and retained historical `fitness.activity.raw` payloads through
   the canonical source records;
2. extracts only known stable identity fields using the versioned mapping;
3. upserts identity projection rows idempotently by user/source activity/kind/
   namespace/value/field;
4. reports unsupported or conflicting payload fields without deleting raw data;
5. accepts explicit bounded date/user filters and can be safely rerun.

The deploy migration creates only relational structures and indexes. It does not
run an unbounded `INSERT ... SELECT` backfill. The ClickHouse/dbt models refresh
the historical range under the existing bounded analytics workflow. Provider
network fetches are out of scope for this backfill and will be documented as a
separate operator procedure if a provider cannot recover an identity from raw
payloads.

## Testing and verification

Unit tests cover identity normalization, strength ranking, route fingerprint
normalization, geometry thresholds, direction, interval-source precedence,
trend deltas, stale threshold rejection, and quality aggregation. Integration
tests cover real Postgres canonical-group/member projection and real ClickHouse
route/metric behavior; tests do not rely on SQL-string assertions for database
semantics.

The verification run will:

- build the bounded identity and route models against the available historical
  range;
- query `find_repeated_efforts` for the user's cycling history;
- report counts by effort kind and strength, exact provider-defined repeats,
  repeated routes, most frequent efforts, multi-year groups, provider identity
  coverage, and remaining limitations;
- run several longitudinal comparisons prioritized as exact workouts/tests,
  exact/high-confidence routes/climbs, strongly comparable structured efforts,
  same-name/same-duration candidates, and generic historical observations only
  as descriptive evidence.

The result must state when the configured local environment cannot provide a
complete historical dataset or analytics refresh rather than presenting an
incomplete sample as the user's full history.
