# 8a.nu Native Catalogue Identity TDD Plan

> **For agentic workers:** Use superpowers:test-driven-development before implementation and superpowers:executing-plans for task execution.

**Goal:** Let synced 8a.nu / Vertical-Life log entries obtain native catalogue identity evidence when the upstream record proves the route identity.

**Behavior:** Native catalogue matches use a verified unified climb ID or trusted route URL. Ascents without sufficient identity evidence remain discovery suggestions.

**Scope:** Verify the ingestion identity contract, map proven climb identity through the existing canonical graph, and supply the catalogue seed. Do not infer identity from ascent IDs, names, grades or geography alone. Do not introduce duplicate storage or change cross-provider match thresholds.

**Docs:** [Logbook API research](../../climbing-logbook-api-research.md), [climbing trait coverage](../../climbing-trait-coverage.md), [ascent parser](../../../src/providers/eight-a/ascent.ts), [seed loader](../../../src/db/climbing-catalogue-seed.ts). The [deployed vendor client](https://www.8a.nu/_nuxt/BvPRvgJk.js) and [public detail example](https://vlcapi.vertical-life.info/outdoor/v1/web/crags/bouldering/united-states/camp-4/sectors/unknown-sector-5dd83/routes/midnight-lightning) are source references; detail `unifiedId` differs from legacy `zlaggableId`.

## Current Evidence

The ascent parser deliberately emits `climb.externalId: null`. The seed loader emits `sourceUrl: null`; the occurrence key `eight-a:native:...` identifies an ascent, not a catalogue climb. Consequently, app-owned 8a entries currently use name discovery. PR #3201 adds that catalogue discovery, while native ingestion identity is a separately approved follow-up.

## Test Strategy and File Structure

- Unit: `src/providers/eight-a/ascent.test.ts` verifies fixture-backed mapping and leaves unproven IDs unknown. `packages/climbing-catalogue/src/vertical-life.test.ts` verifies unified-ID checks.
- Integration: `src/db/climbing-catalogue-seed.integration.test.ts` executes the real seed query against Postgres with a minimal fixture. Existing source-import tests verify canonical ownership and repeated occurrences.
- Parity: web and mobile consume the shared source confidence; verify the shared response and both existing catalogue view tests.

## Tasks

- [ ] Inspect a populated upstream ascent response and its corresponding trusted route detail. Record the identity field, platform namespace, URL navigation and counterexamples. Stop for direction if the vendor response does not establish a stable mapping.
- [ ] Write failing parser tests for proven route identity, unknown identity, legacy versus unified IDs and repeated ascents of one climb. Run `rtk proxy pnpm exec vitest run --project unit src/providers/eight-a/ascent.test.ts` and confirm the intended failure.
- [ ] Implement the minimum fixture-backed mapping in `src/providers/eight-a/ascent.ts`, using existing canonical identity fields. Do not guess a unified ID from a legacy ID.
- [ ] Write a failing real-Postgres seed integration test, then update `src/db/climbing-catalogue-seed.ts` to supply the verified identity/URL without adding duplicate storage. Run `rtk proxy pnpm test:integration -- src/db/climbing-catalogue-seed.integration.test.ts` following the testing guide.
- [ ] Verify a native source match through the shared catalogue service, and retain possible-match behavior when identity is unavailable. Run library, shared service and paired client view tests, lint and typechecks.
- [ ] Update the current provider documentation with citations to the verified contracts. Evaluate historical sync requirements from recorded evidence rather than adding a temporary identity bridge.

## Open Verification

The exact upstream ascent identity fields and populated indoor identity coverage must be verified before choosing a mapping. Existing route detail identity does not prove that an identically named field on an ascent uses the same namespace.
