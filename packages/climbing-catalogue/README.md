# @dofek/climbing-catalogue

Cross-provider climbing route search and conservative identity matching, with
source attribution and human-readable evidence. Independent of Dofek application
packages, databases, queues, caches, and UI frameworks.

```sh
npm install @dofek/climbing-catalogue
```

Requires Node.js 22.14 or newer. Ships ESM JavaScript and TypeScript declarations.

## Search

```ts
import { ClimbingCatalogueSearch } from "@dofek/climbing-catalogue";
import { MountainProjectCatalogueAdapter } from "@dofek/climbing-catalogue/mountain-project";
import { OpenBetaCatalogueAdapter } from "@dofek/climbing-catalogue/openbeta";

const search = new ClimbingCatalogueSearch([
  new MountainProjectCatalogueAdapter(fetch),
  new OpenBetaCatalogueAdapter(fetch),
]);

const sources = await search.search({
  providerId: "mountain-project",
  externalId: "105736399",
  sourceUrl: "https://www.mountainproject.com/route/105736399/cheddar-corner",
  name: "Cheddar Corner",
  kind: "route",
  setting: "outdoor",
  locations: [],
});

for (const source of sources) {
  console.log(source.providerId, source.searchComplete);
  for (const match of source.matches) {
    console.log(match.confidence, match.candidate.url, match.evidence);
  }
}
```

The native provider is queried first when the seed has an external ID. Its
current name, aliases, references, and locations inform subsequent discovery;
the original seed is unchanged. Provider results validate before matching.
An unsuccessful provider request rejects the search: callers own error reporting,
user messages, caching, scheduling, and retry policy.

All seed fields shown above are required; `externalId`, `sourceUrl`, `name`,
`kind`, and `setting` may be null. Optional `aliases` and `references` carry
source-declared identity evidence. No user ID or log-entry ID is needed.
Location ancestry is ordered root to leaf. Each location has nullable `externalId`
and `name`, `scope: "area" | "climb"`, and nullable
`coordinates: { latitude, longitude }`. Area coordinates and route coordinates
remain distinct observations.

## Source area context

Area locations may include optional `context` with a source URL, nullable literal
area type, plain-text sections, attributed tags with nullable source counts, and
source statistics. Sections and tags retain inherited-area labels when supplied.
These remain area observations: descriptions, counts and categorical steepness
do not become route measurements. Climb-scoped locations cannot carry this
context; see the [schemas](src/contracts.ts) and [plain-text projection](src/area-context.ts).

| Source | Area fields and hydration boundary |
| --- | --- |
| KAYA | Inline public and authenticated native destination/area/subarea fields supply descriptions, access text, type and access flags. Gym profiles retain address and website context. The separately verified native selection excludes unsupported public-only short descriptions. Parent references retain native IDs; no recursive location query is added. See the [reader](src/kaya.ts) and [native location client](https://set.plastick.rocks/location-11950.js.map). |
| Mountain Project | A native route's local area and its immediate parent supply source sections, access notes and route-type counts. Name-discovery hits lack a proven parent ID, so their area context remains unavailable rather than guessed. See the [reader](src/mountain-project.ts). |
| OpenBeta | The local area and immediate parent supply description/location text and source grade/discipline totals. Area reads are shared within a search and validate native UUIDs. See the [reader](src/openbeta.ts) and upstream [Area schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Area.gql). |
| theCrag | Proven hierarchy IDs supply area pages with matching canonical native IDs. Only `.regions__read > .regions__inner > .node-info` owns area sections/tags; inherited headers also apply to tags without an inheritance title. Type and displayed route totals retain their source meaning. See the [reader](src/thecrag.ts), [tagging definitions](https://www.thecrag.com/en/article/tagging) and [area documentation](https://www.thecrag.com/en/article/documentingacrag). |
| 8a.nu / Vertical-Life | Verified crag and broader area records supply descriptions/access, crag flags with literal counts, and source statistics. Native crag/area identities are checked before attaching context. See the [reader](src/vertical-life.ts). |

Absent fields stay absent or nullable; each reader retains its observed source
contract rather than synthesizing tags from prose. Hydration requests are shared
within a search; callers own longer-lived caching, as defined by the
[adapter interface](src/contracts.ts) and readers above.

## Match decisions

| Confidence | Meaning |
| --- | --- |
| `source` | The recorded provider and external ID match; contradictions remain in the evidence. |
| `reference` | An explicit provider reference links the climbs without conflicting evidence. |
| `corroborated` | Exact/alias name, known kind, outdoor setting, compatible nearby local areas, complete discovery, and one plausible candidate support identity. |
| `possible` | A discovery suggestion requiring review; fuzzy names never establish identity. |

These are evidence-based suggestions, not instructions to merge records. A
complete search is scoped to its returned `searchArea` when supplied; an empty
incomplete result does not establish absence. Grades and tags stay attributed
to each provider. The library writes nothing and selects no stored winner.
See the [matching implementation](src/matching.ts) and its [regressions](src/matching.test.ts).

## Provider adapters and transport

Each adapter implements `ClimbingCatalogueAdapter`: a `providerId` and
`search(seed): Promise<CatalogueSearchResult>`. Use a subset of providers or
supply your own adapter for one of the supported provider namespaces.

| Subpath | Export | Constructor |
| --- | --- | --- |
| `kaya` | `KayaCatalogueAdapter` | `(fetchFn, getAccessToken)` |
| `mountain-project` | `MountainProjectCatalogueAdapter` | `(fetchFn = fetch)` |
| `openbeta` | `OpenBetaCatalogueAdapter` | `(fetchFn)` |
| `thecrag` | `TheCragCatalogueAdapter` | `(fetchFn)` |
| `vertical-life` | `VerticalLifeCatalogueAdapter` | `(fetchFn)` |

Kaya's token resolver returns `Promise<string | null>`; return null for public
metadata or resolve the current user's access token for authenticated details.
Supply your own rate-limited fetch, request deadlines, or specialized transport.
The library does not load credentials or set up sessions.

Vertical-Life uses the `eight-a` provider namespace and public outdoor route
search. Native detail lookup uses an 8a.nu route URL and validates its unified
ID against the recorded ID. Discovery shares a three-page budget across names;
incomplete results remain suggestions. Coordinates, wall angles and tags are
left unknown when absent from the response. The transport reads the
[collection search](https://vlcapi.vertical-life.info/collection/v1/web/search?query=Midnight%20Lightning&pageIndex=0&pageSize=5&entityTypes%5B%5D=3)
and [outdoor detail](https://vlcapi.vertical-life.info/outdoor/v1/web/crags/bouldering/united-states/camp-4/sectors/unknown-sector-5dd83/routes/midnight-lightning)
contracts used by the [deployed web client](https://www.8a.nu/_nuxt/BvPRvgJk.js).
The search record's `zlaggableId` matches the detail record's `unifiedId`;
the detail record's separate `zlaggableId` is not the catalogue identity
([example search](https://vlcapi.vertical-life.info/collection/v1/web/search?query=Midnight%20Lightning&pageIndex=0&pageSize=5&entityTypes%5B%5D=3),
[example detail](https://vlcapi.vertical-life.info/outdoor/v1/web/crags/bouldering/united-states/camp-4/sectors/unknown-sector-5dd83/routes/midnight-lightning)).

The adapters read observed application endpoints and may need updates when
providers change them. They are unofficial and unaffiliated with the providers.
Source references: [Kaya web application](https://kaya-app.kayaclimb.com/),
[Mountain Project route JSON](https://www.mountainproject.com/api/v2/routes/105734660),
[OpenBeta GraphQL schema](https://github.com/OpenBeta/openbeta-graphql/blob/develop/src/graphql/schema/Climb.gql),
and [theCrag public route search](https://www.thecrag.com/en/climbing/world/search).
Use only data you are authorized to access and follow each provider's terms.

## Pure matching and schemas

```ts
import { matchCatalogueCandidates } from "@dofek/climbing-catalogue/matching";
import { catalogueSeedSchema } from "@dofek/climbing-catalogue/contracts";

const seed = catalogueSeedSchema.parse(input);
const matches = matchCatalogueCandidates(seed, providerResult, seed.locations);
```

`matching` exports name normalization, query-name preparation, name comparison,
local-area selection, the 100-metre proximity policy, and candidate matching.
`contracts` exports Zod schemas for seeds, locations, tags, candidates, search
results, and attributed source results, with named inferred types for each
except tags. Use `CatalogueCandidate["tags"][number]` for a candidate tag. `geometry`
exports coordinate and numeric wall-angle schemas. `kaya-tags` exposes literal
Kaya tag decoding independently of the search adapter. Import subpaths when
only one provider or pure contract is needed.

## Development

```sh
pnpm --dir packages/climbing-catalogue test
pnpm --dir packages/climbing-catalogue build
pnpm --dir packages/climbing-catalogue typecheck
```

Tests run without databases, credentials, or live provider requests. Packaging
uses pnpm's [publish configuration overrides](https://pnpm.io/package_json#publishconfig)
to expose compiled files while workspace consumers use TypeScript sources.
