# Climbing Catalogue Matching Implementation Plan

> Checkboxes record completion of each implementation step.

**Goal:** Apply the approved evidence rules to cached cross-provider climb enrichment.

**Architecture:** Keep provider discovery separate from shared deterministic matching policy. Extend the disposable response with provider references and evidence, use bounded local OpenBeta discovery for renames, and render the server's decisions on both clients.

**Tech Stack:** TypeScript, Zod, Fuse.js 7.5.0, Vitest, existing cache and provider HTTP infrastructure.

**Spec:** `docs/superpowers/specs/2026-10-29-climbing-catalogue-matching-design.md`

## Global Constraints

- All results remain disposable, attributed cache data.
- Do not merge stored climbs, change recorded grades or training metrics, create ticks, or add catalogue tables, secrets, or background crawling.
- Keep adapters isolated. Shared matching/name policy is a server-side module.
- Use great-circle metres, with a conservative 100 m local-area tolerance.
- At least one known outdoor setting is required for ordinary geographical corroboration.
- Hydrate at most three matching OpenBeta areas, with a 200-climb hydration bound; preserve incomplete coverage.
- Every result carries concise human-readable evidence; clients display server decisions without computing matches.

## Review Focus

- A distant or incompatible namesake must not create local ambiguity, but an unlocated plausible namesake must.
- Shared broad ancestors must not override credible nearest-area conflicts.
- Explicit references must survive renames, while contradictory references remain qualified.
- Native IDs are distinct from URL slug suffixes and must survive source renames.
- Partial/duplicate/malformed area discovery must not masquerade as complete local coverage.

---

### Task 1: Shared evidence contract and matching policy

**Files:** Modify `packages/training/src/climbing-catalogue.ts`, its test, `src/climbing-catalogue.ts`, its test, root `package.json` and `pnpm-lock.yaml`. Create `src/climbing-catalogue-matching.ts` and colocated test. Update directly affected root test fixtures if necessary.

**Interfaces:**
- Extend candidate and seed schemas with optional `references: {providerId: CatalogueProviderId, externalId: string}[]` and `aliases: string[]`, representing source evidence when available.
- Extend search results with optional `searchArea: CatalogueLocation`, meaning a complete result may cover that matched local area rather than the world. Carry this into returned sources.
- Add `reference` confidence beside `source`, `corroborated`, `possible`; optional `evidence: string[]` on matches is an additive response field for independently released clients/servers. New service responses always populate it.
- Produce server helpers `normalizeCatalogueName(value: string): string`, `catalogueNameMatch(name: string, candidate: {name: string; aliases?: string[]}): "exact" | "alias" | "approximate" | null`, `catalogueLocalArea(locations: CatalogueLocation[]): CatalogueLocation | null`, and `matchCatalogueCandidates(seed: CatalogueSeed, found: CatalogueSearchResult, recordedLocations: CatalogueLocation[])` returning typed attributed matches. The required third argument retains original geographical evidence independently of current discovery context. Adapters in Task 2 consume these helpers.

- [x] Write tests first: native rename stays source; renamed explicit MP reference becomes reference; contradictory reference stays possible with evidence; punctuation/article normalization; approximate/qualifier changes stay possible; grade changes remain attributed; nearby unique local match survives distant/wrong-kind namesakes; ambiguous/unlocated candidate stays possible; incomplete discovery stays possible; shared-ancestor conflict blocks corroboration; unknown setting differs from known conflict; known indoor matching stays possible.
- [x] Run `rtk pnpm exec vitest run --project unit src/climbing-catalogue.test.ts src/climbing-catalogue-matching.test.ts packages/training/src/climbing-catalogue.test.ts` and record expected RED evidence.
- [x] Implement the schema and shared helper module. Pin root Fuse.js 7.5.0. Use Fuse with `threshold: 0.25`, `ignoreLocation: true` only for approximate discovery; never promote a fuzzy result automatically. Keep unknown and contradiction distinct. Match local area at 100 m using spherical distance and compatible geographic scope; do not count identical route/area points twice. Compare nearest-area evidence before any ancestor alignment.
- [x] Update refresh to get exact native-source context before parallel remaining adapters, using discovered references/current source names for disposable discovery while retaining original key inputs. Use a new cache namespace. Preserve ownership, TTL, failure and invalidation behavior.
- [x] Run focused suites, self-review, commit the task and push automatically. Report RED/GREEN evidence and any downstream fixture updates for Task 3.

### Task 2: Provider discovery and real Goat Rock fixtures

**Files:** Modify catalogue adapters and colocated tests: `src/providers/openbeta-catalogue.ts`, `src/providers/mountain-project-catalogue.ts`, `src/providers/kaya/catalogue.ts`, `src/providers/thecrag/catalogue.ts`. Expose the existing distance predicate from `src/climbing-catalogue-matching.ts` and cover its production adapter use in its colocated test. Add small source fixture/test-helper files only where necessary. Update `docs/climbing-trait-coverage.md` with cited discovery evidence.

**Interfaces:** Consume Task 1 helpers and optional references/searchArea. Keep the existing `ClimbingCatalogueAdapter.search(seed)` entry point. Export the existing private distance predicate as `catalogueAreasAreNearby(left: CatalogueLocation, right: CatalogueLocation): boolean` and its shared `CATALOGUE_LOCAL_AREA_METRES = 100` constant so OpenBeta discovery and matching use one geographic policy.

- [x] Write failing tests using the real provider identities: MP Cheddar Corner `105736399`; OpenBeta Corner Route `f3a2b199-c2d3-59b8-8f12-dd7ce734e88b`, parent Goat Rock `0045f7bf-6b6c-5d8a-bc9a-30f9168aea37`, parent MP ID `105734054`; native area coordinates 37.2282,-122.1079. Cover local-area discovery independent of route name and reverse MP reference lookup; duplicates, mismatched area identity, partial count and bounds; unknown coordinates; article aliases and approximate suggestions with preserved qualifiers; KAYA native IDs distinct from slug suffix; theCrag scoped coordinate parsing.
- [x] Run changed provider test files and record RED evidence.
- [x] Implement verified OpenBeta `cragsWithin(filter:{bbox,zoom:15})` discovery around the nearest recorded area point (100 m in metres, convert to latitude-aware bbox). Select matching nearest areas by explicit area reference when provider-owned IDs support it, otherwise normalized area name plus distance. Hydrate `area(uuid)` including `totalClimbs`, metadata MP references and climb facts; construct candidates with parent context. Check unique returned count against total, cap 200 hydrated climbs and three areas, and preserve incomplete results. Keep the existing bounded global name search when local evidence is unavailable; it is ordinary discovery, not an error-suppression fallback. Request `metadata.mp_id` for native climbs and put it in candidate references. Preserve source setting as unknown unless explicitly supplied.
- [x] Make Mountain Project follow an explicit reference when supplied; all adapters use shared name relation for bounded discovery. Do not hardcode Goat Rock identities or aliases. Parse theCrag's verified displayed coordinate conservatively at area scope. Keep errors actionable and reported through the existing service boundary.
- [x] Run provider suites plus shared matching suites and available source-composition/job tests; document the public contracts with primary-source citations. Commit and push automatically.

### Task 3: Evidence presentation, integration validation and documentation

**Files:** Modify `packages/web/src/components/ClimbingCatalogueContext.tsx`, `packages/mobile/components/ClimbingCatalogueContext.tsx`, their tests/stories, shared training presentation helpers/tests, and directly affected server/job/schema fixtures. Update `packages/training/README.md` and `docs/climbing-trait-coverage.md` as needed.

**Interfaces:** Consume Task 1's confidence and evidence without recomputing matching policy on clients. Shared presentation labels belong in `@dofek/training/climbing-catalogue`.

- [x] Write failing paired client tests for `reference` -> `Provider reference`, visible server evidence and conflicts, local coverage wording, and qualified empty/incomplete results. Preserve existing disclosure accessibility and cached/loading/error behavior. Include fixture variants for the renamed Goat Rock counterpart and a contradictory possible match.
- [x] Run the paired tests and record RED evidence.
- [x] Implement matching shared labels on both clients. Replace misleading `No exact-name catalogue matches found.` copy with wording reflecting the actual search and its completeness. Update typed fixtures affected by the additive contract and document the matching rules/fixtures with primary-source citations.
- [x] Run targeted unit/mobile suites, typecheck, lint, and the repository's unit/mobile test tier. Use a real database integration suite only if database behavior changes. Do not alter SQL just to carry new enrichment facts.
- [x] Start the required Storybook HTTP server and `/Users/asherlc/bin/paseo-quick-tunnel <port>` together; visually check the specific catalogue stories with browser tooling. Report only story-specific tunnel URLs. Stop both together when verification ends.
- [x] Self-review, commit and push automatically; provide validation evidence. A whole-branch independent review follows before completion.

## Completion — 2026-10-29

Implementation and independent task/whole-branch reviews are complete. The final
review corrections are committed in `af0555949` and pushed to `lawful-robin`.
The final code passed 22,919 unit/mobile tests (19 skipped), full lint, and
root/training/server/web/mobile typechecks. Real browser checks covered provider
references, conflicts, incomplete results, disclosure state, and mixed-confidence
ordering on both clients. Native Simulator execution was not part of this check.

Earlier live Goat Rock lookups verified forward/reverse provider references and
local Swiss Cheese corroboration. The latest live recheck encountered an OpenBeta
HTTP 504, so upstream availability remains a limit on that final live validation.
No retry or timeout workaround was added. Validation servers and their paired
tunnels were stopped after the browser checks. No merge or deployment was performed.
