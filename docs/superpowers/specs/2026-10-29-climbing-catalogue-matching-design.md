# Evidence-based climbing catalogue matching

Status: the user approved the proposed matching rules in conversation on
2026-10-29. This refines the [cache-only enrichment design](2026-10-27-climbing-catalogue-enrichment-design.md).

## Outcome and boundaries

Recognize explicit cross-provider references and presentation aliases, resolve
name ambiguity within the relevant place, and expose the reasons for uncertain
or conflicting matches. All results remain disposable, attributed cache data.
Do not merge stored climbs, change recorded grades or training metrics, create
ticks, or add catalogue tables, secrets, or background crawling.

Use an ordered evidence cascade: native source identity, explicit provider
reference, corroborated local name/alias, possible candidate. This follows the
separation of candidate generation from comparison described in
[Splink's blocking guide](https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html).

## Rules

- Native `(providerId, externalId)` survives a rename. Explicit cross-provider
  references bypass name equality. Known kind, setting, or credible local-area
  contradictions keep a cross-reference possible and explain the conflict.
- Match the nearest available local areas, allowing extra hierarchy levels.
  Never let agreement on a broad ancestor override contradictory nearer areas.
  Geography supports place identity; coincident route/area coordinates do not
  establish route identity. Use great-circle metres, with a conservative 100 m
  local-area tolerance, an explicit Dofek heuristic tested against the observed
  Goat Rock area points (maximum separation under 30 m).
- Normalize Unicode, case, whitespace, apostrophes, punctuation and trailing
  articles such as `Great Roof, The`. Preserve directional, start, extension,
  traverse and pitch qualifiers. Provider-declared aliases can corroborate;
  approximate names only generate possible candidates. Use the maintained
  [Fuse.js](https://github.com/krisk/Fuse) package (latest stable 7.5.0 verified
  with npm on the audit date) for bounded typo suggestions, never as an identity
  probability. Do not implement a second string-distance library.
- Require known compatible route/boulder kind and independently corroborated
  local geography for inferred identity. Missing setting is unknown; known
  indoor/outdoor disagreement is a conflict. Indoor cross-provider guesses stay
  possible without verified gym/set identity. At least one known outdoor setting
  is required for ordinary geographical corroboration.
- Judge uniqueness after removing candidates credibly outside the local place
  or with incompatible known kinds/settings. A plausible competing local or
  unlocated candidate prevents automatic corroboration. Capped discovery cannot
  establish uniqueness unless a separately complete matched-area lookup does.
- Grades and protection styles remain independent observations and do not veto
  otherwise supported identity. Every result carries concise human-readable
  evidence; clients display server decisions without computing matches.

## Provider discovery

Keep adapters isolated. Shared matching/name policy is a server-side module.
Use native source lookup before other provider discovery so known current source
names, locations and explicit references can be used without persisting them.
Preserve the original logged facts and cache-key input.

OpenBeta exposes `metadata.mp_id` in its [Climb schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Climb.gql).
Live introspection verified no direct MP-ID lookup. A bounded
`cragsWithin(filter:{bbox,zoom:15})` lookup followed by `area(uuid)` can discover
and hydrate a matching local leaf area independently of route name. The
[area data source](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/model/AreaDataSource.ts)
returns leaf areas without pagination or sampling; compare hydrated unique climb
count with `totalClimbs` before claiming area completeness. Bound discovery to
the nearest recorded local area, hydrate at most three matching areas, and retain
an incomplete result when coverage or the 200-climb hydration bound is exceeded.
Embedded geographic search results do not reliably populate MP references;
identity evidence comes from hydrated areas or native climbs.

Other adapters reuse bounded existing search/detail endpoints with shared name
normalization and retain useful approximate suggestions. Mountain Project can
follow an explicit MP reference. theCrag can retain the public route's displayed
coordinate at the nearest area scope when it coincides with that area's point;
do not invent surveyed route precision or infer outdoor from provider identity.

## Acceptance fixtures

| Case | Required behavior |
| --- | --- |
| [MP Cheddar Corner](https://www.mountainproject.com/route/105736399/cheddar-corner) vs [OpenBeta Corner Route](https://openbeta.io/climb/f3a2b199-c2d3-59b8-8f12-dd7ce734e88b/corner-route), MP reference `105736399` | Explicitly linked despite name/style disagreement |
| [Swiss Cheese](https://www.mountainproject.com/route/105734732/swiss-cheese) plus distant exact-name climbs | Local counterpart can corroborate when local discovery is complete |
| [Goat Rock Center Route](https://www.mountainproject.com/route/105734639/center-route) vs [Chew Tooth Center Route](https://www.mountainproject.com/route/105735353/center-route) | Different nearby areas remain distinct despite shared park ancestry |
| [The Great Roof](https://www.mountainproject.com/route/105734687/the-great-roof) vs its displayed `Great Roof, The` label | Presentation normalization preserves the candidate |
| `Corner`, `Corner route`, `Gouda Arete` | Weak resemblance alone cannot establish identity or erase variants |
| Swiss Cheese [MP 5.4](https://www.mountainproject.com/route/105734732/swiss-cheese), [theCrag 5.5](https://www.thecrag.com/en/climbing/united-states/castle-rock-state-park/route/18578575), [KAYA 5.6](https://kaya-app.kayaclimb.com/climb/Swiss-Cheese-56-Castle-Rock-State-Park-6084576) | Keep attributed grades; grade disagreement alone does not decide identity |

## Delivery

Invalidate disposable old matching cache values with a new namespace. Preserve
existing cache expiry, ownership, error reporting and user erasure behavior.
Expose explicit-reference confidence and concise evidence on both web and mobile,
including accessible labels, and keep MCP on the same response schema. Cover
each changed behavior with failing tests before implementation. Verify provider
parsers with public-response fixtures, then shared/server/client suites,
typechecking, lint and a browser check of the specific catalogue story.
