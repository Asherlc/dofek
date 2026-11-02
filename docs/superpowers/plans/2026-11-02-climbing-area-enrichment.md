# Climbing Area Enrichment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven development to implement task-by-task.

**Goal:** Include attributed higher-level metadata from the five climbing catalogues and display it consistently on web/mobile.

**Architecture:** Add optional area context to catalogue locations, hydrate source-owned parent records in each adapter, and render a disclosure in both clients. Parent request memoization is scoped to one search. Cache keys advance to v4 and share enrichment across repeated source climbs. Training reads this same disposable cache.

**Approved expansion:** Training reads cached enrichment and queues missing
lookups; server calculations support include/exclude area metadata, recorded
route precedence and per-category source evidence. Both clients use the
approved beside-chart layout with compact inheritance trees. No classification
summary line or separate area/provider categories. Existing cache is the single
disposable source of enrichment; no new persisted analytics facts.

**Tech Stack:** TypeScript, Zod, Cheerio, React, React Native, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-11-02-climbing-area-enrichment.md`.

## Global Constraints

- Area context stays separate from route facts; no canonical database writes.
- No new dependency, credential, public/native field assumption or fallback transport.
- Retain current matching semantics, source attribution, bounded discovery and actionable failures.
- No source statistics or descriptions become inferred route metrics.
- Literal area tags may contribute to missing training dimensions while enabled;
  the recorded route fields themselves remain untouched.
- Both clients receive the same validated context; client code renders/formats only.

## Review Focus

- Parent coordinates stay on their actual area; never propagate them to route/sector points.
- Context URLs belong to the recorded provider and exclude credentials.
- Repeated parent IDs reuse reads only within the current search.
- Plain text conversion retains text while removing executable markup.
- Area aggregate flags/counts and explicit inherited tags stay distinguishable from route facts.

### Task 1: Shared contract and source text normalization

**Files:** `packages/climbing-catalogue/src/contracts.ts`, its test; new `area-context.ts` and its test; `src/climbing-catalogue.ts` and cache tests.

- [ ] Write failing contract tests for populated area context, wrong-provider links, route-point misuse and count validation.
- [ ] Write and run failing text-normalization tests; implement a Cheerio-based plain-text helper using the existing dependency.
- [ ] Add optional `CatalogueLocation.context` with validated source URL, type, sections, area tags/counts and statistics. Export production-consumed types.
- [x] Advance cache key namespace to v4 and update existing key expectations.
- [ ] Run library/cache tests and typechecks. Review checkpoint: contract and scope safety.

### Task 2: Provider parent readers

**Files:** five catalogue adapters and their colocated tests/fixtures.

- [ ] Add failing source-shaped fixtures/tests before each provider implementation.
- [ ] Vertical-Life: hydrate unique crags and available parent areas; preserve `topFlags` counts as area observations, public coordinates, text and identified source counts.
- [ ] Mountain Project: hydrate parent areas/hierarchy from native route identity; retain section/access prose, coordinates and source type counts.
- [ ] KAYA: read verified public location/gym fields, preserving ancestry and population limits; do not request authenticated/admin-only fields from public types.
- [ ] theCrag: preserve parent page tags/content and explicit inherited provenance, sharing existing tag parsing rather than duplicating it.
- [ ] OpenBeta: hydrate area descriptions, hierarchy and verified source counts using existing GraphQL transport and source identifiers.
- [ ] Verify request reuse, malformed responses and HTTP failures for each reader. Run library tests and live read-only smoke checks. Review checkpoint: source contract fidelity.

### Task 3: Paired presentation

**Files:** web/mobile catalogue context views; new area-context components with colocated tests/stories; shared formatting helpers if needed.

- [ ] Write failing paired tests for area identity/source link, tags/count qualifiers, descriptions/access, statistics and accessible expand/collapse.
- [ ] Implement matching disclosures and wire them into existing candidate locations.
- [ ] Add representative paired Storybook fixtures. Start preview servers with required quick tunnels; inspect the specific stories with browser tooling.
- [ ] Run paired view tests and typechecks. Review checkpoint: area/route distinction and accessibility.

### Task 4: Verification and PR update

### Training integration checkpoint (before final verification)

- [ ] TDD cached source-to-training trait mapping, evidence scopes and identity gates.
- [ ] Batch-load current owned seeds; reuse cache for repeat climbs; queue missing
  source reads without upstream HTTP in request handlers; invalidate strengths
  after worker completion and surface lookup failures.
- [ ] TDD route precedence, include/exclude area calculations and example provenance.
- [ ] Implement paired controls, beside-chart responsive layout and source trees;
  verify interactions and both clients' query inputs.
- [ ] Run executable PostgreSQL tests for bulk seed selection/ownership/visibility.

- [ ] Update current library/provider documentation with primary-source citations.
- [ ] Run full lint, spelling, root/server/web/mobile/library typechecks and unit/mobile tests; build and verify packed exports.
- [ ] Audit full visible logbook read-only to measure area-context additions without overwriting recorded facts.
- [ ] Request independent final review, fix validated findings with tests, commit/push, update PR #3201 and monitor checks/review feedback.

## Working ledger

- User approved pulling higher-level metadata into enrichment after the provider comparison. Native eight-a ingestion identity remains separate in issue #3204.
- Execution: inline implementation with independent source research and a final reviewer; no branch switch. Existing PR remains the delivery vehicle.
- Ruling: ingest verified descriptive/access/style fields, coordinates and explicitly labelled counts/ratings. Uninterpreted grade-index arrays and transient locked weather payloads are not mapped without a verified display meaning.
