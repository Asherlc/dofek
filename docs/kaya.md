# Kaya provider

The `kaya` provider connects a user’s Kaya account with their email and
password, then syncs climbing sessions, ascents, and attempted climbs from Kaya’s authenticated
application API. `kaya-export` remains a separate CSV-import provider.

The contract in [kaya-api.openapi.yaml](kaya-api.openapi.yaml) records responses
observed from the authenticated [Kaya web app](https://kaya-app.kayaclimb.com/).

For routes, the ascent's nullable `lead` Boolean takes precedence over
`climb.lead`: explicit true means lead and explicit false means top rope.
When ascent-level data is null or absent, Dofek falls back to the route flag.
When both are missing, the method remains unknown; boulder methods remain null.
This precedence was verified on 2026-10-29 through authenticated
[ascentsForUser requests](https://kaya-beta.kayaclimb.com/graphql): two lead
ascents returned `lead: true` while their nested climb definitions returned
`lead: false`. Session attempted-climb records have no separate ascent value
and use their route flag. The [client](../packages/kaya-client/src/client.ts)
retains both fields, and the [adapter](../src/providers/kaya-sync.ts) resolves
them before persistence. Sync again after deploying this fix to refresh
existing logs while retaining their IDs and activity attachments.

Published `climb.grade` belongs to Climb; an ascent's own grade belongs to its
log. See the [model](climbing-context.md) and observed
[application API](https://kaya-beta.kayaclimb.com/graphql).

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
The resolved ascent-first `lead` value supplies the method on every counted
occurrence; source result, qualifier, and repeat facts describe only one try.
The session query also requests the non-null `sent` Boolean. An explicit false
records `Attempt` on every counted occurrence; true records one generic `Send`
and leaves additional occurrence outcomes unknown. The original Boolean stays
in raw provenance. This does not assign Onsight, Flash, or an attempt index.
The field's Boolean contract and the Cave Route's three attempts with
`sent: false` were verified through the authenticated
[GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql) on 2026-10-26.
Kaya documents separate [attempt and send controls](https://kayaclimb.com/support-articles/logging-your-climbs-on-kaya)
and [attempt logging with Send disabled](https://kayaclimb.com/blog/logging-attempts-on-kaya).
Earlier imports did not request this field; sync Kaya again to acquire the
recorded status. Existing unknown records are not rewritten without source evidence.
The [adapter](../src/providers/kaya-sync.ts) supplies those method-bearing
occurrences to the shared writer instead of creating methodless route rows.
A missing total creates one occurrence; the count alone does not
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

The [client](../packages/kaya-client/src/client.ts) selects shared climb fields
on both the session-attempt and ascent feeds. It preserves selected source
metadata in raw provenance and the [adapter](../src/providers/kaya-sync.ts)
normalizes supported facts into the canonical climbing model. The
[field inventory](climbing-trait-coverage.md#kaya-field-inventory) distinguishes
current requests, authenticated field checks, source-bundle observations and
intentional exclusions. It is an inventory of inspected surfaces, not a complete
upstream schema: the authenticated [GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql)
rejected introspection during the 2026-10-27 audit.

| Record | Current handling |
| --- | --- |
| Session | Dates, notes, gym and board/destination context; attempted climbs include `attempts: session_attempts` and `sent`. |
| Shared climb | Identity, color, lead flag, catalogue grade, source locations including `wallarea`, native climb coordinates, board and angle; descriptions, source media references and other selected catalogue metadata remain raw on both feeds. See the [exact field inventory](climbing-trait-coverage.md#kaya-field-inventory). |
| Climb tags | Request `tags { id name color icon tag_type_id }`; normalize explicit grip tags as a collection and retain all supplied tags raw. |
| Ascent | Request its own nullable `lead` flag separately from `climb.lead`, its own grade separately from `climb.grade`, comments, rating, stiffness, attempts, result, photo and video metadata. The ascent grade belongs to the log's reported-grade collection. |

The tag contract comes from the [Plastick Tag fragment](https://set.plastick.rocks/tag-11950.js.map)
and authenticated reads of both feeds on 2026-10-27. Plastick's
[definitions](https://set.plastick.rocks/index-11950.js.map) identify
`tag_type_id: "3"` as GRIP; its [gym-map filter](https://set.plastick.rocks/index-119504.js.map)
uses that category to select grip tags. The authenticated `allTags` dictionary
contained Crimp, Sloper, Pinch, Pocket, Jug, Volume, Jam and No Grips. Dofek maps
these explicit grip tags to `holdTypes`, preserving multiple grips without
choosing a predominant one. Tags of other categories and unfamiliar tags stay
raw. See the [observed contract](kaya-api.openapi.yaml) and
[source mapping](../src/providers/kaya-sync.ts).

The 2026-10-27 authenticated sample covered 28 sessions, 91 attempted-climb
records and 60 ascents. Neither feed supplied any climb tags; one ascent climb
had an angle, one had native climb coordinates, and one had a description. All 60 ascents supplied their own grade,
with one differing from its catalogue grade; none supplied a video. These are
sample coverage counts, not guarantees about other accounts or future responses.
The complete new client selections and runtime response parser also passed a
read-only run across the 28 sessions and 60 ascents. Source: authenticated
[Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql). Earlier versions
of this document incorrectly described ascent grades as requested; the previous
query omitted them. A normal successful sync fetches the newly selected facts
for existing records through the complete feeds.

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
also returned `25`. Missing values remain `null`. These public catalogue values
were observed through the [Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql)
on 2026-09-29.

The 2026-10-27 review of Plastick's
[outdoor editor source map](https://set.plastick.rocks/GuidebookView-11950.js.map),
`src/container/Destination/GuidebookClimbsContainer.jsx`, established a distinct
outdoor convention: its Angle dropdown maps Slab to `-20`, Vertical to `0`,
Overhang to `20`, and Roof to `50`, then renders those values as category names.
Dofek retains those explicit outdoor categories as `{ category: "slab" }` and
the equivalent vertical/overhang/roof values. They are not measured degrees.
Board values and unrecognized numeric values retain `unit: null`; their units
and reference convention have not been independently established by this audit.

The importer stores supplied nodes in destination/area/subarea/wallarea order as an
Area parent chain with their Kaya IDs. When no such path is supplied, the gym
fallback uses the climb, ascent, then session gym. Board metadata comes from
the climb reference. Shared strengths analytics use the recorded categories
without converting them into numeric measurements; unknown-unit values remain
excluded from degree comparisons. See the
[angle and hold contracts](../packages/training/src/climbing-experience.ts)
and [strengths service](../packages/server/src/services/climbing-strengths.ts).
Kaya CSV exports preserve their gym
name with unknown ID and normalize ascent labels and counts into Attempt facts.
CSV grades are conservatively stored as separately reported grades because
the row supplies no independently identified catalogue definition; this does
not claim that Kaya labels the column as a personal grade opinion.
CSV exports do not provide a rope-method column; route methods remain
unknown rather than being inferred from grades or results. See the
[CSV parser](../src/providers/kaya/import.ts) and
[nullable method contract](climbing-context.md).

Successful API and CSV refreshes update source records in place, retaining
entry IDs, activity associations, and detailed attempts. They preserve entries
attached from other providers. Complete session responses mark missing records
from that source as absent; an export with parse errors cannot establish absence
and retains the earlier records. Reappearing records recover their original IDs.
The [shared database writer](../src/db/climbing-log-sync.ts) enforces source
scope inside the import transaction; executable [API](../packages/server/src/repositories/kaya-sync.integration.test.ts)
and [CSV](../src/providers/kaya/import.integration.test.ts) regressions cover
refreshes, partial exports, and record preservation. The API fetches and
reconciles complete session and ascent feeds on each sync, including history
before the requested window. See the [sync implementation](../src/providers/kaya-sync.ts).

Board names can describe a model/layout, such as
[Moonboard (2016)](https://kaya-app.kayaclimb.com/location/Moonboard-2016-701910),
or a venue-specific board, such as
[Summit Plano Moonboard](https://kaya-app.kayaclimb.com/location/Summit-Plano-Moonboard-682352).
The location search returned several distinct `Cragmont Park` records with
different IDs and hierarchy levels. Preserve provider IDs alongside names;
names alone do not identify a location. Source: the read-only
[Kaya location search](https://kaya-beta.kayaclimb.com/graphql), observed 2026-09-29.


## Serving imported traits

The canonical import retains plural grips and categorical wall angles. Updated
web and mobile clients request `responseVersion: 2` on the existing climbing
detail, attachment-suggestion and provider-record procedures. Version `1`
remains the default for older clients: it returns a scalar only for one
distinct grip supported by that contract, and returns null for categorical
angles. Numeric values retain their supplied units. This response projection
does not change the stored source facts or select a predominant grip. See the
[shared version policy](../packages/training/src/climbing-log-response.ts) and
[complete response contract](climbing-context.md#response-versions-and-independent-releases).

Updated clients also validate the earlier response shape when deployed before
the new API; the previous `z.object` input ignores the new version option.
The supported versions are explicit strict schemas, following
[Zod's object behavior](https://zod.dev/api#objects) and
[tRPC input/output validation](https://trpc.io/docs/server/validators).
MCP callers select the same policy with `response_version` on
`get_activity_details`, `get_climbing_sessions`, and `get_climbing_progression`.
The [maintenance migration](../drizzle/0170_climbing_traits.sql) still requires
the normal [database/application deployment procedure](../deploy/README.md);
response versions address client compatibility, not database rollout ordering.
After that release, a normal sync refreshes existing records through both
complete KAYA feeds; the [source and coverage audit](climbing-trait-coverage.md#repeating-the-audit)
defines the checks before declaring production metadata recovered.

## Unnamed climb labels

The [client](../packages/kaya-client/src/client.ts) requests `color { name }`
for both ascents and attempted climbs. Color remains part of each log's raw
source payload; missing climb names remain null in the catalogue. The shared
[label formatter](../packages/training/src/climbing-log.ts) uses an existing
climb name or log title first, then a recorded color and climb kind, such as
“Blue boulder.” Cards, record details, and map labels use this presentation on
both platforms. Existing records acquire color when Kaya sync fetches them again.
The [API audit above](#confirmed-request-coverage) is the evidence for the color field.

Climbing card summaries show Onsight or Flash without the redundant attempts
count and omit the generic “Completed” wording. Other reported counts and
failure results remain visible; the underlying attempts and outcomes are unchanged.
See the [shared formatter](../packages/format/src/climbing-log.ts).

## Ascent photographs

The current [Kaya application fragment](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js)
selects `photo { photo_url thumb_url }` on `WebAscentFields` (inspected
2026-10-26). The authenticated ascent feed requests those same photo fields;
photographs are retained in the source log payload and discovered after its
ClimbingLogEntry is persisted. Both session-attached and standalone ascents
use the existing private [image pipeline](../src/db/activity-images.ts).

The next normal sync discovers photographs on historical ascents using its
already complete feed; no separate historical scan or per-ascent sync request
is needed. The [adapter](../src/providers/kaya-sync.ts) keeps one stable photo
slot per ascent, prefers `photo_url`, and offers `thumb_url` as an alternative.
The [media mapper](../src/providers/kaya-sync.ts) identifies revisions from
the underlying URL after removing signing parameters, so rotating signatures
do not replace an image while a changed source photograph does. Explicit
`photo: null` establishes no photograph; omitted, malformed, or empty photo
objects remain incomplete and cannot retire stored photographs. Video
thumbnails and climb galleries are outside this import.

Expired links refresh through the same verified authenticated
`ascentsForUser` list and select the exact ascent ID. A single-ascent lookup
was not established by the inspected application; see the existing
[client query contract](../packages/kaya-client/src/client.ts). This means an
expired-link refresh can read the complete paginated ascent feed. Inspection
verified the current application fragment, and executable client/provider
tests cover discovery and refresh; this change has not independently verified
an authenticated account with a populated photo or downloaded its real bytes.
