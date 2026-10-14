# Climbing logs

A climbing log entry records an occurrence on a Climb, optionally associated with a timed Activity. Areas, Climbs, and Pitches are shared source objects; attempts record execution facts. The [shared model](../packages/training/src/climbing-log.ts), [database schema](../src/db/schema/climbing.ts), and [response contract](../packages/server/src/contracts/climbing-log-contracts.ts) define the current names and nullable fields.

## Ownership and location

| Model | Canonical facts |
| --- | --- |
| Area | Owner/provider, verified source identity, name, nullable parent Area and coordinates |
| Climb | Owner/provider, verified source identity, nullable name/kind/Area/setting, advertised route protection, coordinates, ordered published grades |
| Pitch | Required Climb, nullable verified identity/number/name, ordered published grades |
| ClimbingLogEntry | Owner/provider, occurrence identity, optional Climb/Activity, independently nullable source date, discipline/title/notes, reported grades, board/angle/hold type, raw source record and retention metadata |
| ClimbingAttempt | Required log, scope, optional Pitch/parent, nullable actual order/outcome, independent method/solo/protection/aid/fall-or-hang/dab/beta/history facts and notes |

Areas form an adjacency list through `parentAreaId`. PostgreSQL recursive queries build the current path; ownership constraints and cycle checks protect the hierarchy. Shared metadata updates apply to past logs referencing the same verified source object. Unidentified objects remain local to their log; matching names do not establish identity. See the [schema](../src/db/schema/climbing.ts) and PostgreSQL [recursive queries](https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-RECURSIVE).

API coordinates use `GpsCoordinates { latitude, longitude }`. PostgreSQL stores one native `point`, with x = longitude and y = latitude. Coordinates must be finite and within ±180° longitude and ±90° latitude; zero is valid. See the [value type](../packages/training/src/gps-coordinates.ts) and PostgreSQL's [geometric types](https://www.postgresql.org/docs/current/datatype-geometric.html).

Published grade components belong to their Climb or Pitch. Independently reported grades belong to the log. Each component has a value and nullable grading system, with collection order stored on its owned grade row. Progression ranks use published grades. See the [grade definitions](../packages/training/src/climbing-grades.ts) and [observation query](../packages/server/src/repositories/climbing-rock-observations.ts).

## Attempts and interpretation

Whole-Climb attempts have no Pitch or parent. Pitch attempts may reference an identified Pitch and a whole-Climb parent in the same log; unknown pitch identity is retained without creating a catalogue object. Parent relationships have one level. Catalogue pitch counts and route extent do not establish tries. The [writer](../src/db/climbing-log-sync.ts) validates these relationships and expands a reported count N into N occurrences at the reported scope. A missing total retains one occurrence with unknown details. It makes no completeness claim.

`outcome` is `completed`, `failed`, or null. Completion, rope method, solo, protection, aid, fall/hang, dab, and history are independent facts. Aid use does not establish a fall or hang. `fellOrHung` retains the combined source condition; unknown booleans remain null. See the [fact normalizer](../src/db/source-attempt-facts.ts).

The server derives a free rock send from completion with known absence of aid and falls/hangs; bouldering also requires known absence of a dab. Generic completion remains visible when execution facts are unknown. Source first-try qualifiers establish order 1 on an identified target. Flash supplies inferred beta only when no other retained log identifies the same target; independently supplied beta survives that guard. Missing prior history never becomes a stored false. The [reader](../packages/server/src/repositories/climbing-activity-log-entry-repository.ts) returns derived labels alongside complete recorded facts.

## Enums

| Type | Values |
| --- | --- |
| ClimbKind | `boulder`, `route`, `summit` |
| ClimbSetting | `indoor`, `outdoor` |
| ClimbingDiscipline | `rock_climbing`, `ice_climbing`, `mixed_climbing`, `snow_climbing`, `hiking`, `scrambling`, `mountaineering` |
| AttemptScope | `climb`, `pitch` |
| AttemptOutcome | `completed`, `failed` |
| RopeMethod | `lead`, `top_rope`, `follow`, `unroped` |
| ProtectionStyle | `sport`, `trad` |
| GradeSystem | `v_scale`, `font`, `yds`, `french`, `uiaa`, `ewbank`, `saxon`, `norwegian`, `brazilian_crux`, `british_adjectival`, `british_technical`, `aid`, `water_ice`, `alpine_ice`, `mixed`, `ifas`, `nccs` |

Nullable fields carry unknown state separately from these enum values. The [shared schemas](../packages/training/src/climbing-log.ts) and [grade library](../packages/training/src/climbing-grades.ts) are authoritative. The generated [UML](schema.puml) includes the database tables, enums, and ownership relationships.

## Browsing, attachment, and analytics

Both clients render concise cards and expose full facts through details. Provider record details fetch the selected log's full owned graph. Cached records remain visible during refresh errors. Source date stays independent of Activity: attaching or deleting the Activity preserves it. The server suggests active, unattached logs with a matching known day for climbing or hiking Activities; attachment is explicit. See the [association service](../packages/server/src/repositories/climbing-log-entry-associator.ts) and [paired details](../packages/web/src/components/ClimbingLogEntryDetails.tsx).

Analytics default to whole-Climb scope. Explicit pitch filters use pitch observations. Progression lanes separate kind, scope, rope method, solo, aid, and compatible published free-grade system; setting remains separate. Generic logs stay browseable, and ungraded known rock records retain participation. Counts and rates come from the server, with unknown execution distinguished from known failures. Source records are retained during ingestion; query-time mirror selection preserves distinct repeats and conflicting evidence. See the [observation query](../packages/server/src/repositories/climbing-rock-observations.ts) and [progression repository](../packages/server/src/repositories/climbing-progression-repository.ts).

The current filters independently select kind, scope, rope method, solo, aid, actual protection, advertised protection, and setting, including explicit false and unknown values. See the [filter contract](../packages/training/src/climbing-filters.ts).

## Maintenance cutover

Existing installations require the quiesced, bounded [climbing-log model cutover](climbing-log-model-cutover.md). Fresh databases can apply preparation and finalization directly because they have no legacy records. Conversion gates preserve source evidence before removing old storage; see [0146](../drizzle/0146_climbing_log_model_prepare.sql) and [0147](../drizzle/0147_climbing_log_model_finalize.sql).
