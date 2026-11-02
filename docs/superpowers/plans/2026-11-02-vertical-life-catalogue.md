# Vertical-Life Catalogue Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Vertical-Life route discovery to climbing enrichment on both clients.

**Architecture:** Add `VerticalLifeCatalogueAdapter` to the independent catalogue library and compose it in the shared server pipeline. Use the existing `eight-a` provider namespace, public API transport, and conservative identity matching. No new dependencies or credentials.

**Tech Stack:** TypeScript, Zod, Vitest.

**Spec:** User-approved adapter approach in this conversation: verify route search/details, retain attribution, and serve both clients through the shared pipeline.

## Global Constraints

- Keep credentials, rate limiting and persistence outside the library.
- Preserve native unified IDs, root-to-leaf ancestry and unknown coordinates/angles.
- Bound discovery to three pages across all names; never claim completeness from mixed-entity totals.
- Use public API reads only; do not fetch premium content.

## Review Focus

- Search `zlaggableId` and detail `unifiedId` identify the same climb; detail `zlaggableId` does not.
- Aliases and pagination share a bounded budget; repeated or exhausted pages are incomplete.
- Native URLs must be provider-owned route paths; detail IDs must agree with the seed.
- Unknown geometry and source tags remain unknown, rather than inferred.
- HTTP errors, malformed JSON and malformed records reject enrichment explicitly.

### Task 1: Adapter and shared pipeline

**Files:** Create `packages/climbing-catalogue/src/vertical-life.ts` and its colocated test; modify `contracts.ts`, `package.json`, `src/climbing-catalogue-sources.ts` and its test; update library README.

**Interfaces:** Produces `VerticalLifeCatalogueAdapter(fetchFn: typeof fetch)` implementing `ClimbingCatalogueAdapter`, provider ID `eight-a`.

- [x] Write tests for mapping, native detail identity, URL validation, discovery bounds/aliases/repetition, and explicit failures; update composition test.
- [x] Run new tests and observe missing adapter/composition failures.
- [x] Implement public search and native detail lookup, extend contracts/exports, and register rate-limited transport.
- [x] Run library tests, composition tests, typecheck, lint and packed-export verification. Expected: pass.
- [x] Review the full diff, commit and push the completed change.

## Verified source evidence

The [deployed client](https://www.8a.nu/_nuxt/BvPRvgJk.js) exposes collection search and outdoor detail routes. Read-only requests on 2026-11-02 to [search](https://vlcapi.vertical-life.info/collection/v1/web/search?query=Midnight%20Lightning&pageIndex=0&pageSize=5&entityTypes%5B%5D=3) and [detail](https://vlcapi.vertical-life.info/outdoor/v1/web/crags/bouldering/united-states/camp-4/sectors/unknown-sector-5dd83/routes/midnight-lightning) returned HTTP 200 without credentials. Search pages 0 and 1 returned distinct records. The web host returned Cloudflare 403; the API host succeeded.

## Working notes

Direction approved by user. Existing workspace retained; no branch switch. Review checkpoints: failing tests before implementation, passing verification before commit, independent final review before completion.

Review: independent reviewer found no important or critical issues. Minor follow-ups deferred: malformed percent escapes produce a raw URI error rather than the adapter's URL message; add a direct three-distinct-full-pages budget test (current tests cover repeated pages and alias budget exhaustion).

Live verification exposed a valid literal plus sign in the slug `midnight-lentejuelas-l1+l2`. A regression test failed before the slug validation fix and passed afterward. The final live adapter search returned 17 candidates with incomplete discovery, and native detail lookup returned unified ID `36615`.

Verification: library suite passed 495 tests; service/composition suites passed 81 tests; paired web/mobile catalogue views passed 51 tests. Root and library typechecks, `pnpm lint:sandbox`, package build and packed-install import passed. The complete Docker-free unit/mobile suite passed 24,262 tests across 1,476 files with exit code 0 (19 tests and two files skipped). No database or client rendering behavior changed.
