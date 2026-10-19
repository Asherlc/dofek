# Kaya provider

The `kaya` provider connects a user’s Kaya account with their email and
password, then syncs climbing sessions, ascents, and attempted climbs from Kaya’s authenticated
application API. `kaya-export` remains a separate CSV-import provider.

The contract in [kaya-api.openapi.yaml](kaya-api.openapi.yaml) records responses
observed from the authenticated [Kaya web app](https://kaya-app.kayaclimb.com/).

For routes, Kaya’s explicit `climb.lead` boolean supplies the Attempt's rope
method: `true` is lead and `false` is top-rope. Boulder methods remain unknown
because that boolean does not establish a rope method for boulders. Published
`climb.grade` belongs to Climb; an ascent's own grade belongs to its log. See
the [adapter](../src/providers/kaya-sync.ts), [model](climbing-context.md), and
observed [application API](https://kaya-beta.kayaclimb.com/graphql).

## Attempt occurrences

The session request includes `attempted_climbs` alongside the separate
`ascentsForUser` request. An attempted climb is a climb record whose ID combines
the session and climb IDs, rather than an individual try. It imports as a
ClimbingLogEntry; ascent records keep their own source IDs. A shared climb
reference alone does not establish duplicate effort or overlapping counts.
The [source-scoped writer](../src/db/climbing-log-sync.ts) preserves record
identity; any effort relationship needs separate evidence before query-time
reconciliation. Attempted climbs report their per-climb session count in
`session_attempts`; their `attempts` field can be null even when that count is
known. The session query selects `attempts: session_attempts`, using a
[GraphQL response alias](https://graphql.org/learn/queries/#aliases) to retain the
client's typed `attempts` property. The separate ascent feed uses its own
`attempts` field, which can be null, including for Repeat ascents. Preserve
the reported positive count by creating that many whole-Climb Attempt rows.
A route's explicit `lead` flag supplies the recorded method on every counted
occurrence; source result, qualifier, and repeat facts describe only one try.
The [adapter](../src/providers/kaya-sync.ts) supplies those method-bearing
occurrences to the shared writer instead of creating methodless route rows.
A missing total creates one partially described occurrence; it does not
establish complete lifetime history or a failed attempt. Only supported source
facts describe individual outcomes. Attempted-climb summaries and ascent
records remain separate source observations until evidence establishes overlap.
This contract was verified against the authenticated [Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql)
and [Kaya application](https://kaya-app.kayaclimb.com/) on 2026-09-29; the
attempted-climb count field was verified again on 2026-10-13.

Server summaries count retained scoped occurrences and confirmed free sends.
Unknown completion and execution facts remain explicit; a generic completed
attempt does not prove a free send. No aggregate attempt count or completeness
flag is stored. Dofek qualifies verified API occurrence IDs as
`kaya:ascent:<id>` and `kaya:session:<session>:attempted:<record-id>` independently
of Activity attachment. This is Dofek's identity policy; ascent-ID persistence
through upstream session reassignment has not been independently verified.
See the [writer](../src/db/climbing-log-sync.ts) and
[analytics projection](../packages/server/src/repositories/climbing-rock-observations.ts).

## Confirmed request coverage

The following additional fields were verified in the authenticated API and the
[Kaya application's GraphQL fragments](https://kaya-app.kayaclimb.com/static/js/main.5bd87165.chunk.js)
on 2026-09-29. The import requests location, board, and angle on both feeds;
the remaining omissions are shown below:

| Record | Fields |
| --- | --- |
| Climb, not requested | `slug`, `color { name }`, `description` |
| Climb, requested | `lead`, `grade`, `angle`; `board`, `destination`, `area`, `subarea` (IDs and names) |
| Ascent, requested | Its own `grade`, comments, ratings and stiffness |
| Ascent, not requested | `photo { photo_url thumb_url }`, `video { video_url thumb_url }` |

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

The importer stores supplied nodes in destination/area/subarea order as an
Area parent chain with their Kaya IDs. When no such path is supplied, the gym
fallback uses the climb, ascent, then session gym. Board metadata comes from
the climb reference. Angles retain `unit: null`, including zero and negative
values; degree analytics exclude them. Kaya CSV exports preserve their gym
name with unknown ID and normalize ascent labels and counts into Attempt facts.
CSV grades are conservatively stored as separately reported grades because
the row supplies no independently identified catalogue definition; this does
not claim that Kaya labels the column as a personal grade opinion.
CSV exports containing route attempts without a rope method cannot satisfy the
[required route-method contract](climbing-context.md) and are rejected. The
[CSV parser](../src/providers/kaya/import.ts) has no method column; use an API
source with recorded route methods. Bouldering CSV imports remain supported.
See the [context contract and migration](climbing-context.md) and
[provider mapping](../src/providers/kaya-sync.ts).

Successful API and CSV refreshes update source records in place, retaining
entry IDs, activity associations, and detailed attempts. They preserve entries
attached from other providers. Complete session responses mark missing records
from that source as absent; an export with parse errors cannot establish absence
and retains the earlier records. Reappearing records recover their original IDs.
The [shared database writer](../src/db/climbing-log-sync.ts) enforces source
scope inside the import transaction; executable [API](../packages/server/src/repositories/kaya-sync.integration.test.ts)
and [CSV](../src/providers/kaya/import.integration.test.ts) regressions cover
refreshes, partial exports, and record preservation. The API fetches full
feeds: sessions are filtered locally by `since`, while standalone ascents use
both `since` and `until`. These are current client bounds rather than an
upstream bounded-query guarantee. See the [sync implementation](../src/providers/kaya-sync.ts).

Board names can describe a model/layout, such as
[Moonboard (2016)](https://kaya-app.kayaclimb.com/location/Moonboard-2016-701910),
or a venue-specific board, such as
[Summit Plano Moonboard](https://kaya-app.kayaclimb.com/location/Summit-Plano-Moonboard-682352).
The location search returned several distinct `Cragmont Park` records with
different IDs and hierarchy levels. Preserve provider IDs alongside names;
names alone do not identify a location. Source: the read-only
[Kaya location search](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29.
