# Kaya provider

The `kaya` provider connects a user’s Kaya account with their email and
password, then syncs climbing sessions, ascents, and attempted climbs from Kaya’s authenticated
application API. `kaya-export` remains a separate CSV-import provider.

The contract in [kaya-api.openapi.yaml](kaya-api.openapi.yaml) records responses
observed from the authenticated [Kaya web app](https://kaya-app.kayaclimb.com/).

For routes, Kaya’s explicit `climb.lead` boolean maps to canonical
`climb_style`: `true` is `lead` and `false` is `top-rope`. Boulder methods remain
unknown because Kaya returns `false` for them without a rope-style meaning.
The [read projection](climbing-context.md#interpretation) derives the nullable
lead flag. See the observed [application API](https://kaya-beta.kayaclimb.com/graphql).

## Attempts and unknown counts

The session request includes `attempted_climbs` alongside the separate
`ascentsForUser` request. An attempted climb is a climb record whose ID combines
the session and climb IDs, rather than an individual try. It imports as an unsent
`climbing_entry`; ascent records keep their own source IDs. A shared climb
reference alone does not establish duplicate effort or overlapping counts.
The [source-scoped writer](../src/db/climbing-entry-sync.ts) preserves record
identity; any effort relationship needs separate evidence before query-time
reconciliation. Both responses can supply `attempts: null`. Preserve that
unknown count, and do not infer individual tries or failure reasons.
This contract was verified against the authenticated [Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql)
on 2026-09-29 and the [Kaya application](https://kaya-app.kayaclimb.com/).

Climbing summaries include these records and retain known send counts. An
attempt total is `null` when any contributing count is unknown. Grade volume
also exposes `recordedAttempts`, the subtotal of known counts, or `null` when
none are recorded. Web and mobile grade cards label incomplete subtotals as
"N recorded attempts", use "N attempts" for complete totals, and omit attempts
when no counts are known. Recorded zero remains visible and sends are retained.
See the [web grade card](../packages/web/src/components/ClimbingVolumeByGradeChart.tsx)
and [mobile climbing section](../packages/mobile/app/(tabs)/strain.tsx).
The outcome and count are independently
nullable in PostgreSQL, whose [check constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)
allow unknown values while retaining the positive-count constraint.

## Confirmed request coverage

The following additional fields were verified in the authenticated API and the
[Kaya application's GraphQL fragments](https://kaya-app.kayaclimb.com/static/js/main.5bd87165.chunk.js)
on 2026-09-29. The import requests location, board, and angle on both feeds;
the remaining omissions are shown below:

| Record | Fields |
| --- | --- |
| Climb, not requested | `slug`, `color { name }`, `description` |
| Climb, requested | `angle`; `board`, `destination`, `area`, `subarea` (IDs and names) |
| Ascent | Its own `grade`, `photo { photo_url thumb_url }`, `video { video_url thumb_url }` |

For the reported session, climb colors and slugs were populated; the other
listed metadata was null, and ascent grades matched the climb grades. Session
notes, session board/destination details, and ascent comments/ratings/stiffness
are already requested and preserved in raw payloads. The application fragments
also contain access/moderation metadata and provider-computed aggregates; these
are outside the current import. This is an observed field audit, not an
exhaustive schema inventory: Kaya disables GraphQL introspection on this endpoint.
Source: [Kaya application](https://kaya-app.kayaclimb.com/) and authenticated
[GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29.

## Observed location and angle values

Read-only `webClimb`, `webClimbsForLocation`, and `webSearchForLocation`
requests against the [Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql)
verified these public catalogue examples on 2026-09-29. The selections came
from the [Kaya application's GraphQL fragments](https://kaya-app.kayaclimb.com/static/js/main.5bd87165.chunk.js).
These examples do not identify an account or its logged sessions.

| Climb field | Observed shape | Public example |
| --- | --- | --- |
| `destination` | Nullable location reference with `id` and `name` | `{ id: "1720", name: "Berkeley" }` |
| `area` | Nullable location reference with `id` and `name` | `{ id: "46806", name: "Cragmont Park" }` |
| `subarea` | Nullable location reference with `id` and `name` | `{ id: "46805", name: "Northeast Face" }` |
| `board` | Nullable location reference with `id` and `name` | `{ id: "251", name: "Kilter Board (Original)" }` |
| `angle` | Nullable GraphQL `Int`; confirmed by a field-selection validation response | `-20`, `25`, `40`, `45`, `50` |

[Cragmont Crack](https://kaya-app.kayaclimb.com/climb/Cragmont-Crack-5.6-Berkeley-7599113)
supplies the outdoor hierarchy above and `angle: -20`.
[Kilter Board (Original)](https://kaya-app.kayaclimb.com/location/Kilter-Board-Original-281341)
climbs returned angles `40`, `45`, and `50`; the
[Homewall catalogue](https://kaya-app.kayaclimb.com/location/Kilter-Board-Homewall-962596)
also returned `25`. Missing values remain `null`. The reviewed Kaya resources
do not establish the angle's units, zero, or sign convention; retain the
reported integer until those semantics are verified.

The importer stores outdoor nodes in destination/area/subarea order and keeps
their Kaya IDs and explicit roles. When no outdoor path is supplied, the gym
fallback uses the climb, ascent, then session gym. Board metadata comes from
the climb reference. Angles retain `unit: null`, including zero and negative
values; degree analytics exclude them. Kaya CSV exports preserve their gym
name with unknown ID, their ascent label, and only recorded attempt counts.
See the [context contract and migration](climbing-context.md) and
[provider mapping](../src/providers/kaya-sync.ts).

Successful API and CSV refreshes update source records in place, retaining
entry IDs, activity associations, and detailed attempts. They preserve entries
attached from other providers. Complete session responses mark missing records
from that source as absent; an export with parse errors cannot establish absence
and retains the earlier records. Reappearing records recover their original IDs.
The [shared database writer](../src/db/climbing-entry-sync.ts) enforces source
scope inside the import transaction; executable [API](../packages/server/src/repositories/kaya-sync.integration.test.ts)
and [CSV](../src/providers/kaya/import.integration.test.ts) regressions cover
refreshes, partial exports, and record preservation.

Board names can describe a model/layout, such as
[Moonboard (2016)](https://kaya-app.kayaclimb.com/location/Moonboard-2016-701910),
or a venue-specific board, such as
[Summit Plano Moonboard](https://kaya-app.kayaclimb.com/location/Summit-Plano-Moonboard-682352).
The location search returned several distinct `Cragmont Park` records with
different IDs and hierarchy levels. Preserve provider IDs alongside names;
names alone do not identify a location. Source: the read-only
[Kaya location search](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29.
