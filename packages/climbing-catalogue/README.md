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

Kaya's token resolver returns `Promise<string | null>`; return null for public
metadata or resolve the current user's access token for authenticated details.
Supply your own rate-limited fetch, request deadlines, or specialized transport.
The library does not load credentials or set up sessions.

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
`contracts` exports the Zod schemas and inferred types for seeds, locations,
tags, candidates, search results, and attributed source results. `geometry`
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
