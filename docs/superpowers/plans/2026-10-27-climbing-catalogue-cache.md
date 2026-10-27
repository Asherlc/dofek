# Climbing Catalogue Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Show disposable, attributed catalogue context for recorded climbs across KAYA, Mountain Project and theCrag.

**Architecture:** Provider-local readers produce typed candidate observations. A shared service resolves informational matches and stores expiring user-scoped results in the [existing cache](../../../src/lib/cache.ts). Owned-log APIs and background refresh serve matching web/mobile details and MCP.

**Tech Stack:** Existing TypeScript, Zod, Cheerio, provider HTTP, Redis/BullMQ, tRPC, React and React Native.

**Spec:** [Approved design, including cache-only clarification](../specs/2026-10-27-climbing-catalogue-enrichment-design.md).

## Global Constraints

- No catalogue tables, durable identity links, canonical climb merges, synthetic ticks, or writes of enrichment into existing records.
- Informative catalogue facts do not change training metrics or deduplication.
- Seven-day positive TTL, one-day negative TTL. Errors do not establish no-match.
- Preserve direct/inherited and source attribution; no category-to-degree conversion.
- Re-read owned active records before every cache read or refresh; respect access windows.
- Providers do not import one another. Reuse existing transports; no new dependency or secret.
- Live source contracts are verified before adapter implementation. A partial adapter is not feature completion.

## Review Focus

- Malicious source URLs or redirects must not expand outbound request origins.
- Duplicate/recycled gym names must not become established cross-provider matches.
- Truncated candidate results must not establish uniqueness.
- Deleted/hidden logs and account erasure must prevent stale cache access or resurrection.
- Source errors must remain actionable without erasing unexpired successful context.

## Task 1: Shared informational contract, matching and cache

**Files:** Create packages/training/src/climbing-catalogue.ts and colocated tests; src/climbing-catalogue.ts and src/climbing-catalogue.test.ts. Modify package.json exports only for production consumers.

**Interfaces:** Shared schemas export CatalogueSeed, CatalogueCandidate, CatalogueSearchResult and ClimbingCatalogueContext. CatalogueSeed identifies an owned log/source Climb, name/kind/setting, scoped locations and optional recorded source URL. Candidates carry provider/external ID, URL, name/kind/setting, scoped locations, published grade, attributed tags and a separately unit-qualified numeric angle. Tags preserve sourceKey, label, optional normalized category, kind (steepness/hold/other), direct/inherited scope and optional inheritedFrom.

ClimbingCatalogueAdapter exposes providerId and search(seed: CatalogueSeed): Promise<CatalogueSearchResult>. Search results contain candidates and complete. ClimbingCatalogueService(cache: CacheStore, adapters: readonly ClimbingCatalogueAdapter[]) exposes read(seed), refresh(seed) and markPending(seed). Results contain status, fetchedAt/expiresAt, actionable error and attributed candidate matches; original-source matches remain distinct from corroborated and possible matches.

- [ ] Write failing schema/matching/cache tests: multiple/inherited tags, measured versus categorical angle, same-name distinct areas, indoor set ambiguity, incomplete search, user/fingerprint isolation, expiration, error retention and tag removal after refresh.
- [ ] Run pnpm exec vitest run --project unit packages/training/src/climbing-catalogue.test.ts src/climbing-catalogue.test.ts; verify missing behavior fails.
- [ ] Implement shared contract and cache service using CacheStore; keep all results informational. Corroboration requires unique complete candidate discovery, name/kind agreement and native geographically corroborated location; indoor candidates remain possible unless exact source identity is established.
- [ ] Re-run the focused tests until green, review source attribution and expiry behavior, then commit and push.

## Task 2: Independent provider-local catalogue readers

**Files:** Create src/providers/thecrag/catalogue.ts and catalogue.test.ts; src/providers/kaya/catalogue.ts and catalogue.test.ts; src/providers/mountain-project-catalogue.ts and mountain-project-catalogue.test.ts; src/climbing-catalogue-sources.ts. Update provider source-coverage docs with live evidence.

**Interfaces:** Each adapter implements Task 1's ClimbingCatalogueAdapter. Factory createClimbingCatalogueAdapters(userId: string) returns the three adapters using existing instrumented/rate-limited HTTP boundaries.

- [ ] Verify live exact-name candidates and detail shapes. Known findings: theCrag /en/climbing/world/search?S=...&only=routes has page links; route pages have rel=tag with inherited title. Mountain Project /api/v2/search?q=...&from=... POST accepts types/filter/sort and returns total/hits. KAYA webSearchForClimb accepts offset/count and rich WebClimb fields; tags is rejected on WebClimb. Record limitations explicitly.
- [ ] Write failing provider tests for parsing, blocked/malformed responses, host/route identity validation, pagination cycles/caps, repeated pages, multiple/inherited tags and unknown tag preservation. Mock external HTTP only in unit tests.
- [ ] Run pnpm exec vitest run --project unit src/providers/thecrag/catalogue.test.ts src/providers/kaya/catalogue.test.ts src/providers/mountain-project-catalogue.test.ts; verify failures.
- [ ] Implement bounded search/detail reads. Preserve incomplete=true semantics by returning complete=false whenever caps or repeated pages prevent exhaustive results. Keep known source detail reads independent of search completeness. Never execute scripts or derive traits from descriptions.
- [ ] Re-run provider and Task 1 tests, inspect representative live results, commit and push.

## Task 3: Owned-log service, background refresh and MCP

**Files:** Create src/climbing-catalogue-seed.ts with tests; packages/server/src/repositories/climbing-catalogue-repository.ts with tests/integration test; packages/server/src/mcp/climbing-catalogue-tool.ts with tests. Modify src/jobs/queues.ts, src/jobs/process-post-sync-job.ts, packages/server/src/routers/climbing.ts, packages/server/src/mcp/tools.ts and affected tests.

**Interfaces:** Shared seed builder converts an already-authorized log detail into CatalogueSeed. Server repository loads active owned logs through ClimbingActivityLogEntryRepository.getLogEntries and exposes read(id) / requestRefresh(id). Worker re-loads active owned seed before refresh, checks account-erasure fence, runs factory adapters/service, and invalidates only the dedicated enrichment query. New climbing.catalogueContext query reads cache only; refreshCatalogueContext mutation enqueues a deduplicated user/log job and returns pending state. Separate get_climbing_catalogue_context MCP tool reads cache only with activity:read scope.

- [ ] Write failing router/repository/job/MCP tests for ownership, missing/deleted records, access windows, refresh status, scoped cache keys, erasure, failure surfacing and shared response schema.
- [ ] Run relevant unit suites and verify failures before implementing each interface.
- [ ] Implement query/mutation and worker using existing post-sync queue with a distinct validated payload; preserve existing maintenance/refit behavior. Verify source fingerprint again before writing cache results.
- [ ] Write and run real Postgres integration cases for owned active log loading and rejection after deletion, using pnpm test:integration -- <suite> after reading integration preparation guidance.
- [ ] Verify focused unit and integration suites, commit and push.

## Task 4: Paired detail disclosures and full validation

**Files:** Create packages/web/src/components/ClimbingCatalogueContext.tsx and paired test/story; packages/mobile/components/ClimbingCatalogueContext.tsx and paired test/story. Modify both ClimbingLogEntryDetails components and their stories/tests. Update docs/climbing-trait-coverage.md, docs/thecrag.md and docs/mcp.md to describe cache-only behavior with citations.

**Interfaces:** Detail disclosure consumes catalogueContext query and refreshCatalogueContext mutation. Render server-authored matches/labels, source links, cached fetch date, inherited tags, possible-match qualifiers and actionable refresh errors; no metrics or client matching.

- [ ] Write failing web/mobile interaction tests: collapsed initial disclosure, find/refresh action, pending status, multiple inherited traits, possible matches, expired cache and retained results after refresh errors.
- [ ] Implement both platform components and integrate only in detail views. Keep list cards concise and use existing disclosure/accessibility patterns.
- [ ] Run focused UI tests, then pnpm test --run, package typechecks and required lint. Inspect web/mobile stories with browser tooling; tunnel every started HTTP server and link specific story IDs.
- [ ] Run fresh whole-branch review against this plan and the revised spec. Resolve important findings with regression tests, commit and push. Report remaining provider access/coverage limitations accurately.

## Execution notes

The user authorized implementation. Use inline execution for the shared service,
integration and UI; independent provider readers may be delegated under the
parallel-agent workflow with file ownership kept separate. Review checkpoints
are the end of each task and a fresh whole-branch review. The updated cache-only
spec takes precedence over the earlier durable-catalogue design commit.
