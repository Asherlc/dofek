# Climbing source metadata coverage

This inventory records the source surfaces inspected on 2026-10-27, what Dofek
requests, and how the retained facts can support climbing analysis. Source
capability, a field's population in one account, and current import coverage
are separate questions. The current mappings are the
[Kaya adapter](../src/providers/kaya-sync.ts),
[Mountain Project adapter](../src/providers/mountain-project.ts),
[OpenBeta adapter](../src/providers/openbeta.ts), and
[theCrag parser](../src/providers/thecrag/public-parsing.ts).

## Evidence and audit limits

Kaya's consumer bundle exposes public catalogue and media fragments. Its
Plastick application exposes additional catalogue, tag, gym and location
fragments through public JavaScript source maps. The audit inspected the
[consumer bundle](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js),
[Plastick entry map](https://set.plastick.rocks/index-11950.js.map), and the
relevant feature maps linked below, then checked candidate selections against
the authenticated [Kaya GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql).
The endpoint rejected introspection. A field selected on `OutdoorClimb`,
`WebClimb` or a gym-management `Climb` is therefore evidence to investigate,
not proof that the personal-logbook `Climb` accepts it.

The tables use these distinctions:

- **Requested**: present in Dofek's checked-in client query and retained by its
  response schema. Canonical handling is listed separately from raw provenance.
- **Verified**: accepted in an authenticated read on the audit date; acceptance
  does not establish units, useful population or a canonical mapping.
- **Observed**: selected in the cited upstream application source; not verified
  on the personal-logbook type unless explicitly stated.
- **Excluded**: intentionally outside this import, or rejected on the checked
  type. The reason is recorded instead of treating the field as nonexistent.

There is no GraphQL wildcard selection. This is the complete disposition of the
relevant fields in the inspected fragments, not an exhaustive inventory of
Kaya's upstream schema. The source maps are versioned upstream assets; a future
audit should record the new asset URLs and inspection date rather than assuming
that the fragments or field meanings remain unchanged.
See [GraphQL field selection](https://graphql.org/learn/queries/#fields) and
[introspection](https://graphql.org/learn/introspection/).

## Kaya field inventory

The current request contract is [kaya-api.openapi.yaml](kaya-api.openapi.yaml),
implemented by the [typed client](../packages/kaya-client/src/client.ts).
The rows below group fields by ownership so that an ascent's opinion cannot
silently replace a catalogue grade, and a route photograph cannot be attributed
to an individual's ascent.

| Object | Requested fields and handling | Evidence |
| --- | --- | --- |
| Session | `id`, `start_time`, `end_time`, `notes`, `gym`, `board`, `destination`, `attempted_climbs`. Retain the source session; canonical Activity dates/notes and source context use the existing adapter. | Authenticated [sessionsForUser](https://kaya-beta.kayaclimb.com/graphql); [client](../packages/kaya-client/src/client.ts). |
| Session attempted climb | Shared climb fields plus `attempts: session_attempts` and `sent`. Preserve the composite source identity, count and explicit result; a row is not necessarily one try. | Authenticated [endpoint](https://kaya-beta.kayaclimb.com/graphql); Kaya's [attempt/send controls](https://kayaclimb.com/support-articles/logging-your-climbs-on-kaya). |
| Ascent | `id`, `session_id`, nullable `lead` (verified 2026-10-29; takes precedence over the route flag), `date`, `comment`, `rating`, `stiffness`, `attempts`, `ascent_type { id name }`, `gym`, `climb`, its own `grade`, `photo { photo_url thumb_url }`, `video { video_url thumb_url }`. Catalogue and reported grades have separate owners. Selected media remains raw; the existing image pipeline acquires ascent photographs. | Authenticated [ascentsForUser](https://kaya-beta.kayaclimb.com/graphql); consumer `WebAscentFields` in the [bundle](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js). |
| Shared climb identity and grade | `id`, nullable `name`, `color { name }`, `slug`, `lead`, `climb_type { id name }`, `grade { id name climb_type_group }`. Canonical definitions and supported attempt facts use these values; color and slug remain source provenance. | Authenticated [endpoint](https://kaya-beta.kayaclimb.com/graphql); [consumer climb fragments](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js). |
| Shared climb context | `gym`, `destination`, `area`, `subarea`, `board`, `angle`, native climb `latitude`/`longitude`, and `wallarea { id name photo_url location_type { id name } climb_type_id }`. Provider IDs identify source locations; names alone do not. The richer gym/location selections are listed below. | Authenticated [endpoint](https://kaya-beta.kayaclimb.com/graphql); [location fragment](https://set.plastick.rocks/location-11950.js.map); [client selection](../packages/kaya-client/src/client.ts). |
| Climb tags | `tags { id name color icon tag_type_id }` on both feeds. Normalize the explicit GRIP category into plural `holdTypes`; preserve every selected tag raw, including non-grip and unfamiliar tags. | Authenticated [endpoint](https://kaya-beta.kayaclimb.com/graphql); [Tag fragment](https://set.plastick.rocks/tag-11950.js.map), [tag definitions](https://set.plastick.rocks/index-11950.js.map). |
| Additional shared climb provenance | `description`, `access_description`, `protection_description`, `is_benchmark`, `bolts`, `pitches`, `is_trad`, `length`, `fa`, `date_set`, `date_updated`, `photo_url`, `location`, `risk`, `intensity`, `complexity`, `gem`, `anchor`, `thumbnail_url`, `video_url`, `video_thumbnail_url`, `wall_set_id`. Selected on both feeds and retained raw; no arbitrary scale or units are assigned to unmapped metadata. | Authenticated [endpoint](https://kaya-beta.kayaclimb.com/graphql); [outdoor](https://set.plastick.rocks/GuidebookView-11950.js.map) and [general Climb](https://set.plastick.rocks/wallset-11950.js.map) fragments; [client](../packages/kaya-client/src/client.ts). |
| Location references | `id`, `name`, `latitude`, `longitude`, `description`, `access_description`, `approach_minutes`, `photo_url`, `location_type { id name }`, `parent_location { id name }` on destination/area/subarea/board, including session context. Additional source text and parent/type metadata remain raw. | Live authenticated [client reads](https://kaya-beta.kayaclimb.com/graphql); [LocationFields](https://set.plastick.rocks/location-11950.js.map). |
| Gym references | `id`, `name`, `address`, `city`, `region`, `country`, `latitude`, `longitude`, `slug`, `website`, `nickname`, `postal_code`, `photo_url`, `thumbnail_url`, `banner_photo_url`, `is_official`. Additional profile facts remain raw. | Live authenticated [client reads](https://kaya-beta.kayaclimb.com/graphql); [GymFields](https://set.plastick.rocks/gym-11950.js.map). |

### Verified additional metadata and type boundaries

On 2026-10-27, the authenticated logbook `Climb` accepted the following
additional scalar fields: `description`, `access_description`,
`protection_description`, `is_benchmark`, `bolts`, `pitches`, `is_trad`,
`length`, `latitude`, `longitude`, `fa`, `date_set`, `date_updated`, `photo_url`,
`location`, `risk`, `intensity`, `complexity`, `gem`, `anchor`, `thumbnail_url`,
`video_url`, `video_thumbnail_url`, `wall_set_id`, and `points`. It also accepted
`wallarea { id name photo_url location_type { id name } climb_type_id }`.
The current request includes the additional fields above except `points`,
which is excluded as source competition scoring. The
[client query](../packages/kaya-client/src/client.ts) is the source of truth for
current selections. Unmapped descriptions, media and catalogue metadata stay
in raw provenance rather than acquiring speculative canonical units or meaning.
Sources: authenticated [GraphQL reads](https://kaya-beta.kayaclimb.com/graphql),
[OutdoorClimbFields](https://set.plastick.rocks/GuidebookView-11950.js.map), and
[ClimbFields](https://set.plastick.rocks/wallset-11950.js.map).

The same checked logbook type rejected `notes`, `stripped`, `setter_ids`,
`competition_category_ids`, `tag_ids`, `wall_id`, `circuit_id`,
`circuit_custom_id`, `climb_status_id`, and `climb_type_id`. Some exist on the
gym-management fragment; requesting them on the personal feed would invalidate
the query. `tag_ids` is unnecessary when the feed supplies full `tags` objects.
Source: authenticated [GraphQL validation](https://kaya-beta.kayaclimb.com/graphql)
and the distinct [gym Climb fragment](https://set.plastick.rocks/wallset-11950.js.map).
The personal feed's `Gym` also rejected `date_tz`; Dofek does not request it.
Its appearance in the administrative [GymFields](https://set.plastick.rocks/gym-11950.js.map)
does not establish availability on every gym type.

### Remaining observed surfaces and exclusions

| Surface | Observed fields | Disposition and evidence |
| --- | --- | --- |
| Outdoor catalogue | `wall_topo_shapes { id wall_topo_id shape_points single_points }`; `photo_url`, source dates, route coordinates, descriptions, `fa`, `bolts`, `pitches`, `is_trad`, `length`, `is_benchmark`. | Verified overlapping logbook fields are covered above. Topographic shapes are observed on `OutdoorClimb` and are outside the current personal-log import; they do not establish per-ascent media. [Outdoor fragment](https://set.plastick.rocks/GuidebookView-11950.js.map). |
| Grade definitions | `id`, `name`, `climb_type_id`, `grade_type_id`, `ordering`, `mapped_grade_ids`, `climb_type_group`. | Import recorded grade values with their evidenced scale. Upstream ordering and mapped IDs do not replace Dofek's shared grade conversion. [GradeFields](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js). |
| Location detail | Beyond the requested fields: `wall_topos`, `parking_pois`, `has_trails`; bouldering/route-specific descriptions, short descriptions, access descriptions, access-issue descriptions and approach times; `boundaries_bouldering`, `boundaries_routes`; `lco_name`, `lco_photo_url`, `lco_bio`, `lco_url`. | Additional guidebook text, boundaries, parking, trails, topos and organization profiles are observed catalogue surfaces without a current canonical consumer. [Location fragment](https://set.plastick.rocks/location-11950.js.map). |
| Gym administration | Beyond the requested profile fields: `date_tz`, `created_by`, `date_created`, `climb_types`. | `date_tz` was rejected on the personal-feed Gym. The other administrative fields are observed but not requested. Existing session clock handling stays in the [time-context adapter](../src/providers/kaya-sync.ts). [Gym fragment](https://set.plastick.rocks/gym-11950.js.map). |
| Facility/setter workflow | Wall IDs, anchors, lane/group/map geometry, set identities/dates, setter IDs, climb status, circuits, competition categories and competition points; risk/intensity/complexity fields and `gem`. | Selected useful source facts remain raw where their semantics have no current consumer. Facility operations and competition scoring are not imported as workout performance metrics. [Wall](https://set.plastick.rocks/wall-11950.js.map), [WallSet/Climb](https://set.plastick.rocks/wallset-11950.js.map), and [gym](https://set.plastick.rocks/gym-11950.js.map) fragments. |
| Access/publication state | `has_access_issues`, `access_issues_description`, `is_access_sensitive`, `is_closed`, `closed_date`, `is_published`, `is_gb_moderated`, location moderation flags, `has_maps_disabled`, `is_offensive`. | Observed source state, distinct from personal attempt facts. Preserve selected useful notices raw; moderation/administration does not determine a climber's result. [Outdoor](https://set.plastick.rocks/GuidebookView-11950.js.map), [location](https://set.plastick.rocks/location-11950.js.map), and [consumer](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js) fragments. |
| Upstream aggregates | Ascent/post/review/video/follower counts, ratings, average grade ordering/stiffness, distributions, top videos and recommendation lists. | Excluded from canonical raw workout facts and computed locally where needed. Public galleries/top videos are not evidence of an individual's ascent photo. [Consumer fragments](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js), [gym activity fragment](https://set.plastick.rocks/ClimbCount-11950.js.map). |
| Billing, permissions and client cache | Subscription/customer/payment references, billing/trial dates, access codes, feature flags, assignments, report URLs and `optimistic @client`. | Intentionally excluded; these are gym operations or local application state, not personal climbing history. [Gym](https://set.plastick.rocks/gym-11950.js.map) and [Climb](https://set.plastick.rocks/wallset-11950.js.map) fragments. |
| Other people's social/profile data | Public user profiles, posts, comments and galleries; premium status and payment/receipt operations. | Outside the connected user's climbing-log import. [Consumer application operations](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js). |

### Hold and angle interpretation

The complete authenticated `allTags` response inspected on 2026-10-27 had 49
tags, including the explicit GRIP names Crimp, Sloper, Pinch, Pocket, Jug,
Volume, Jam and No Grips. The source's category distinguishes these from
movement, style, footwork and custom tags. Multiple supplied grip tags remain a
collection; unknown tags remain raw. Sources: authenticated
[dictionary query](https://kaya-beta.kayaclimb.com/graphql),
[TagFields](https://set.plastick.rocks/tag-11950.js.map), and the
[category filter](https://set.plastick.rocks/index-119504.js.map).

The same [definitions](https://set.plastick.rocks/index-11950.js.map) assign
CUSTOM `1`, MOVEMENT `2`, GRIP `3`, FOOTWORK `4`, GENERAL `5`, STYLE `6`,
CONDITIONS `7`, START `8`, FINISH `9`, and BOLDNESS `10`. All categories are
projected from retained raw records into attributed tags for climb details and
strengths, without being relabeled as grip types. The
[provider decoder](../src/providers/kaya/climbing-tags.ts) preserves literal
labels and unknown category keys; the [generic contract](../packages/training/src/climbing-tags.ts)
keeps source and category identity. No historical backfill or duplicate tag
storage is needed. When no grip
tag is supplied, canonical `holdTypes` remains unknown; the explicit No Grips tag is the
recorded `no_grips` category, not an empty collection. See the
[provider mapping](../src/providers/kaya-sync.ts) and
[shared contract](../packages/training/src/climbing-log.ts).

Plastick's outdoor `WallAngleNicknames` maps `SLAB: -20`, `VERTICAL: 0`,
`OVERHANG: 20`, `ROOF: 50`; the editor renders these integers as named
categories. Dofek retains this convention as categorical wall angle when the
outdoor context is established. It does not convert these codes into measured
degrees. Board values and unrecognized values keep unknown units. Source:
[GuidebookClimbsContainer.jsx in the feature source map](https://set.plastick.rocks/GuidebookView-11950.js.map).

In the inspected connected-account sample, all 28 sessions' 91 attempted-climb
rows and all 60 ascent climbs had empty tag lists. One ascent climb had an
angle (`-20`), one had native climb coordinates, and one had a description. All 60 ascents had a separately
reported grade, with one differing from the catalogue grade; none had a video.
The complete new client queries and runtime response parser also passed a
read-only authenticated run over all 28 sessions and 60 ascents. These
2026-10-27 authenticated [read results](https://kaya-beta.kayaclimb.com/graphql)
explain why adding tag requests does not promise populated hold analysis for
this account. They do not establish that tags are absent from other accounts.

## Other climbing providers

Changing a provider's catalogue-enrichment strategy requires a separate change.
The current source coverage must not be confused with the metadata a service
could expose through another endpoint or page. See the existing
[Mountain Project](mountain-project.md), [theCrag](thecrag.md), and
[OpenBeta](openbeta.md) provider references.

| Provider | Current imported source | Trait interpretation |
| --- | --- | --- |
| Mountain Project | Tick CSV plus route/Area identity and location enrichment; retained source rows and route responses. | The checked tick export and route API response have no structured hold or wall-angle field. Descriptions and protection text are present in route JSON; full route JSON remains in `raw.sourceEnrichment.route`. Gear/ascent style and description text do not establish recorded grip categories or measured angles. Sources: observed [route API](https://www.mountainproject.com/api/v2/routes/105734660), [tick-export contract](mountain-project.md#tick-export-contract), and [client](../packages/mountain-project-client/src/client.ts). |
| OpenBeta | Public ticks, recorded result/style, grades, identified climbs/pitches and Area ancestry/coordinates. | The current query selects no grip or wall-angle field. This describes Dofek's selection, not an assertion that every upstream surface lacks those facts. [Importer query](../src/providers/openbeta.ts); [upstream GraphQL source](https://github.com/OpenBeta/openbeta-graphql). |
| theCrag | Public ascent feed and ascent pages; public route/method/result/grade fields retained per ascent. | Public route pages expose structured categorical steepness and style tags, including multiple and inherited tags. The present parser does not fetch that route catalogue metadata, so this is a known enrichment gap. Ascent gear style is distinct from those traits. [Current parser](../src/providers/thecrag/public-parsing.ts); upstream [structured-tag definitions](https://www.thecrag.com/en/article/tagging), [gear-style definitions](https://www.thecrag.com/en/article/styles), and [feed discussion](https://github.com/theCrag/website/issues/1997). |

The 2026-10-27 theCrag audit verified public route tags independently of the
current importer. [When Your Luck Runs Out](https://www.thecrag.com/en/climbing/australia/south-australia/adelaide/route/521786997)
has Overhung and Roof inherited from Little Arapiles.
[Hard On Traverse](https://www.thecrag.com/en/climbing/united-states/jenner-area/route/16444573)
has inherited Arête, Face, Slab, Overhung and Vertical tags. Multiple tags can
coexist, and inherited tags have different provenance from route-specific facts;
neither establishes numerical degrees or a single predominant angle.

theCrag's [structured-tag taxonomy](https://www.thecrag.com/en/article/tagging)
lists steepness Slab, Vertical, Overhung, Roof and Tufa, and styles Face, Slab,
Crack, Chimney, Offwidth, Dihedral and Arête. Its page distinguishes proposed
tags from established entries; proposed Gymnastic/Dyno/Reachy/Cramped/Stick clip
entries are not evidence of current imported categories. Public tag links use
`rel="tag"`; the steepness Slab provider key is `#Ramp`, distinct from style
`#Slab`. A link's `title` can record inherited provenance. Any future importer
must preserve these distinctions instead of mapping every style to a grip.
Sources: the [taxonomy](https://www.thecrag.com/en/article/tagging) and the two
public route pages above, inspected on the audit date.

No structured crimp/sloper/jug taxonomy was verified in that audit. The separate
Comment keywords cloud includes vendor-derived aggregate words, while
[hashtags](https://www.thecrag.com/article/hashtagging) can contain arbitrary
user labels; neither is a recorded grip classification. The
[supporter logbook API](https://www.thecrag.com/en/article/logbookreadapi) also
documents route tags under its own access conditions, but the public route
pages already demonstrate structured traits. This inventory does not change
the existing public-feed integration or select a new enrichment strategy.

## Informational catalogue cache

Climb details on web and mobile also offer **Catalogue context**, an explicit
lookup across KAYA, Mountain Project, theCrag and OpenBeta. This is disposable reference
information: the [cache service](../src/climbing-catalogue.ts) retains successful
results for seven days and empty results for one day, with source URLs, search
completeness, and source/reference/corroborated/possible-match attribution. It does not
write catalogue facts or inferred identities into the recorded climbing graph,
create ticks, or change grades, outcomes, deduplication or training metrics.
The [owned-log repository](../packages/server/src/repositories/climbing-catalogue-repository.ts)
checks current visibility and the caller's access window before every cache
read or refresh. Clearing the cache loses only this reference information.

Live read-only checks on 2026-10-27 verified these discovery contracts:

- KAYA's consumer [bundle](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js)
  declares `webSearchForClimb(name, offset, count)`. Authenticated logbook fields
  and public `WebClimb` fields are distinct: the public query accepts angle,
  location and published-grade metadata, but rejects `tags`. The
  [catalogue reader](../src/providers/kaya/catalogue.ts) uses the verified search
  response for discovery. With an existing user connection, authenticated
  `climb(id: ...)` reads fetch native Climb details, including `lead`,
  `is_trad`, and the full source tags verified on native Climbs above;
  a read-only production request verified the classification shape on the audit
  date. Explicit `is_trad: true` supplies Trad; `lead: true` with explicit
  `is_trad: false` supplies Sport, as specified by the product mapping. A null
  classification stays unknown. Known IDs bypass name search. Live requests
  include the web application's Origin and Referer headers, and native reads
  use the current user's Bearer token. No grips are inferred from descriptions.
- Mountain Project's [search client](https://www.mountainproject.com/dist/search/block.js?v.5)
  posts to `/api/v2/search?q=...&from=...`. The verified response includes total,
  route IDs/URLs, grades, breadcrumbs and locations. The
  [reader](../src/providers/mountain-project-catalogue.ts) retains all published
  type labels, including Trad, Sport, TR, Mixed and Aid, as climb classifications
  rather than relabeling them steepness, grips or personal ascent methods.
- theCrag's [route search](https://www.thecrag.com/en/climbing/world/search?S=Cragmont%20Crack&only=routes)
  exposes paginated route results. The
  [reader](../src/providers/thecrag/catalogue.ts) fetches bounded candidate details
  and retains route-page tags, including multiple inherited steepness entries.
  A fresh [Cragmont Crack page](https://www.thecrag.com/en/climbing/united-states/california/san-francisco/east-bay-area/route/18589309)
  returned Overhung, Slab (`#Ramp`) and Vertical inherited from Cragmont Park.
  These remain Area context, not three claimed measurements of the route.
  The route's own gear-style band supplies literal climb-type labels such as
  Trad, Sport, Top rope and Mixed trad; personal ascent gear styles are separate.
- OpenBeta uses its public browser's Typesense name-search contract, then the
  GraphQL `climb(uuid: ...)` detail query. True `trad`, `sport`, `bouldering`,
  `deepwatersolo`, `alpine`, `snow`, `ice`, `mixed`, `aid` and `tr` flags remain
  independent source classifications. The verified Cragmont Crack detail has
  both Trad and Top rope. Sources: the official
  [Climb schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Climb.gql),
  [search client](https://github.com/OpenBeta/open-tacos/blob/develop/src/js/typesense/TypesenseClient.ts),
  [public browser search configuration](https://github.com/OpenBeta/open-tacos/blob/develop/.env),
  and [Dofek reader](../src/providers/openbeta-catalogue.ts). The browser search
  credential is public and search-only; no new private credential or service is
  provisioned. Upstream 502 responses remain actionable lookup errors.

Global name searches share at most three page requests per provider across the
current name and all meaningful logged/source aliases, rather than three pages
per alias. Empty and case/whitespace-equivalent queries are removed; punctuation
and route qualifiers remain available to upstream search. Each distinct query
gets its first page before any query receives another page. Unqueried aliases,
unfinished pagination, repeated or omitted results, and detail caps keep combined
coverage incomplete and cannot establish a unique corroborated match. Query
pagination/repetition state is separate from global source-ID deduplication, so
overlap between aliases does not itself imply incomplete coverage. Exact native
and reference lookups, and independently complete OpenBeta local-area discovery,
retain their separate paths. See the [shared query-name policy](../src/climbing-catalogue-matching.ts)
and the provider readers linked above; their upstream protocols are documented by
the [MP search client](https://www.mountainproject.com/dist/search/block.js?v.5),
[KAYA consumer query](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js),
[theCrag route search](https://www.thecrag.com/en/climbing/world/search?S=Cragmont%20Crack&only=routes),
and [OpenBeta search client](https://github.com/OpenBeta/open-tacos/blob/develop/src/js/typesense/TypesenseClient.ts).

Indoor candidates
are possible matches unless the exact recorded provider identity is found;
matching names or recycled colors never establish the same gym set. Failed
refreshes retain still-unexpired context with an actionable error instead of
becoming an empty successful lookup. See the
[shared response](../packages/training/src/climbing-catalogue.ts),
[cache/matching tests](../src/climbing-catalogue.test.ts) and
[database ownership tests](../src/db/climbing-catalogue-seed.integration.test.ts).

Within each provider, the [server matcher](../src/climbing-catalogue-matching.ts)
stably orders matches as source, explicit reference, corroborated, then possible.
It preserves order within each class, every candidate and all evidence; provider
order is unchanged. The [web](../packages/web/src/components/ClimbingCatalogueContext.tsx)
and [mobile](../packages/mobile/components/ClimbingCatalogueContext.tsx) views render
that server order without a client-side score or winner selection.

### Local discovery and identity evidence (2026-10-29)

OpenBeta discovery uses `cragsWithin(filter: { bbox, zoom: 15 })` around the
nearest recorded area point, independently of the route name. Dofek converts
its shared 100 m local-area heuristic to a latitude-aware bounding box. A
provider-owned OpenBeta UUID or Mountain Project area reference selects the
area when available; otherwise the normalized local name and great-circle
distance must agree. The reader hydrates at most three matching leaf areas.
It reads `area(uuid)` metadata and `totalClimbs` before requesting climb facts,
skips areas exceeding the remaining 200-fact processing budget, and compares the
unique retained climb count with `totalClimbs`. It also checks the actual returned
fact count before processing: overruns keep coverage incomplete, processing and
retention stop at the remaining budget, and no further full-area reads occur
after exhaustion. These unpaginated upstream responses can exceed an earlier
advertised count, so the metadata check cannot guarantee a network-level response
size cap. Missing, capped or partial coverage
remains incomplete; `searchArea` records the scope of this lookup. When the
nearest area has no point, the existing bounded Typesense name search remains
available. The API has no cursor or completion flag on these area queries;
the count check follows the upstream leaf-area contract, rather than assuming
that any nonempty response is complete. Sources: the
[Area schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Area.gql),
[area data source](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/model/AreaDataSource.ts),
and [reader and regression fixtures](../src/providers/openbeta-catalogue.test.ts).

The verified [Goat Rock area](https://openbeta.io/area/0045f7bf-6b6c-5d8a-bc9a-30f9168aea37/goat-rock)
has UUID `0045f7bf-6b6c-5d8a-bc9a-30f9168aea37`, Mountain Project area reference
`105734054`, point `37.2282, -122.1079`, and 12 climbs. Hydrated
[Corner Route](https://openbeta.io/climb/f3a2b199-c2d3-59b8-8f12-dd7ce734e88b/corner-route)
explicitly references Mountain Project's
[Cheddar Corner](https://www.mountainproject.com/route/105736399/cheddar-corner)
(`105736399`), despite the different names. Embedded geographic-search climbs
did not reliably populate these references in the live audit: only hydrated
area/native climb `metadata.mp_id` supplies climb identity evidence. Mountain
Project can follow that reference directly through its existing route-detail
endpoint. Neither a grade difference nor coincident area coordinates supplies
or vetoes an identity reference. Sources: the linked public records,
[Climb metadata schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Climb.gql),
and the [MP reader](../src/providers/mountain-project-catalogue.ts).

All four readers use the shared name relation for presentation aliases and
bounded approximate suggestions. Original names and directional/start/extension/
pitch qualifiers remain intact; approximate similarity is discovery evidence,
not identity confidence. The shared matcher uses source-declared aliases and
keeps unknown setting unknown. See the [matching policy](../src/climbing-catalogue-matching.ts)
and [Fuse.js search documentation](https://www.fusejs.io/api/options.html).

theCrag search hydrates at most 60 unique route details over three pages before
checking names and literal route AKA labels, so a route returned under an alias
is not discarded solely because its displayed title differs. A repeated page,
repeated route within one query or omitted detail keeps discovery incomplete;
overlapping route IDs from different name queries share one detail read. AKA labels come
only from `.headline__guts > ul.stats > li[title="Alternate name"]`, as observed
on [this route's "Up" alias](https://www.thecrag.com/en/climbing/thailand/krabi/route/7257755094);
breadcrumb abbreviations are not route aliases. The displayed `Lat/Lon:` pair
in a route's location section triggers a separate read of its nearest retained
native area breadcrumb, when that link has a valid area ID. Only that area's own
`place:location` metadata, on a page with the verified canonical area ID, supplies
area coordinates. Parent reads are deduplicated by native area ID within each
bounded search. The
[Goat Rock route page](https://www.thecrag.com/en/climbing/united-states/castle-rock-state-park/route/18578485)
and [parent area](https://www.thecrag.com/en/climbing/united-states/castle-rock-state-park/area/16447255)
display coincident points; a separately located route never replaces the parent
point. An unavailable parent point leaves area coordinates unknown, while parent
HTTP/identity failures remain actionable lookup errors. A route-only point is not
assigned to area or climb scope because its inheritance is unverified. theCrag
supports individual route/start locations; see
[Locating Routes](https://www.thecrag.com/en/article/geolocation#locating-routes)
and [route Lat/Lon editing](https://www.thecrag.com/article/updatingdescriptions).
Provider identity does not imply outdoor setting. See the
[theCrag reader](../src/providers/thecrag/catalogue.ts).

KAYA native IDs remain distinct from URL slugs: the public
[Swiss Cheese URL](https://kaya-app.kayaclimb.com/climb/Swiss-Cheese-56-Castle-Rock-State-Park-6084576)
has native climb ID `887401`, not suffix `6084576`. Its Goat Rock area is native
ID `46774` at `37.228451, -122.107888`; the broader Castle Rock State Park
destination is `2204`. These are attributed source locations, not interchangeable
route identities. Sources: the audited public search response from KAYA's
[GraphQL endpoint](https://kaya-beta.kayaclimb.com/graphql), the
[consumer identity fields](https://kaya-app.kayaclimb.com/static/js/main.9113009d.chunk.js),
and [KAYA regression](../src/providers/kaya/catalogue.test.ts).

Pending refresh status comes from the live job, independently of metadata TTL;
concurrent refresh requests cannot replace a finished result with a long-lived
pending cache entry. Both clients hide expired context and suppress retained
data after access/ownership errors. The
[worker tests](../src/jobs/climbing-catalogue-job.test.ts) and paired
[web](../packages/web/src/components/ClimbingCatalogueContext.test.tsx)/[mobile](../packages/mobile/components/ClimbingCatalogueContext.test.tsx)
tests cover these lifecycle boundaries. Recorded theCrag numeric route IDs use
the verified `/en/climbing/world/route/<id>` detail path, so a rename does not
force that source record through name search; see the
[reader regression](../src/providers/thecrag/catalogue.test.ts).

## Serving the imported metadata

Canonical records retain the full grip collection and numeric-or-category
wall angle. The existing climbing-detail tRPC procedures support
`responseVersion: 1 | 2 | 3`; omitted versions retain the scalar legacy response,
and updated web/mobile clients explicitly request version `3` for recorded tags.
Versions `1` and `2` omit the new tags field. Their strict decoders also accept
earlier versions `1` and `2`. Publish the version-3 API first: an intermediate
API accepting only versions `1` and `2` rejects version `3` during input
validation. The corresponding MCP tools use
`response_version` and project the response before generating text and
structured output. See the [response-version contract](climbing-context.md#response-versions-and-independent-releases),
[shared policy](../packages/training/src/climbing-log-response.ts), and
[tRPC validation](https://trpc.io/docs/server/validators).

Version `1` cannot represent multiple grips, newer grip kinds, or a categorical
angle; those traits remain unknown in that response rather than becoming an
arbitrary scalar or a measured degree value. The canonical metadata remains
available to version `2` and server analytics. See the
[projection](../packages/training/src/climbing-log-response.ts) and
[strengths service](../packages/server/src/services/climbing-strengths.ts).

The strengths response keeps its existing angle/hold/setting `panels` and adds
`tagPanels` for observed recorded tag categories. Each tag contributes once per
identified climb and category/source; the same grade-adjusted and monthly
calculations apply. Catalogue tags, including inherited Area context, remain
reference information and never affect these metrics. Both clients show every
catalogue tag under its existing disclosure, including unfamiliar tags, instead
of hiding the generic `other` kind. See the
[aggregation](../packages/server/src/services/climbing-strengths.ts),
[web details](../packages/web/src/components/ClimbingCatalogueContext.tsx) and
[mobile details](../packages/mobile/components/ClimbingCatalogueContext.tsx).

## Repeating the audit

For a new source or changed upstream application, record the exact source
asset/page and date, distinguish object types, and validate candidate fields on
the actual feed used by Dofek. For each relevant field, retain its raw owner,
shape, observed population, units/category semantics, request status, canonical
handling or explicit exclusion reason. Verify both session attempts and ascents
instead of assuming that one selected climb surface covers the other.

After a normal sync with the matching importer, compare source record counts,
populated tag/angle/grade counts and representative retained raw records with
the authenticated feed. Preserve source record identities and user-selected
Activity links. The [Kaya refresh tests](../packages/server/src/repositories/kaya-sync.integration.test.ts)
exercise those Dofek contracts; a source field's existence alone is not proof
that it reached storage or analysis.

When a source change affects a shared response shape, verify old-client/new-API
and new-client/old-API combinations, the requested input version, and cache-key
separation. Run both the [source persistence suite](../src/providers/kaya-sync.integration.test.ts)
and [server refresh suite](../packages/server/src/repositories/kaya-sync.integration.test.ts):
their fixtures exercise the same live client contract at different consumers.
The [response regressions](../packages/server/src/contracts/climbing-log-contracts.test.ts)
cover strict decoding and version projection; the
[testing guide](testing.md#integration-dependencies) describes the standalone
`pnpm test:integration` command used for database verification.
