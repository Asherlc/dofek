# KAYA Metadata Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Import verified KAYA metadata faithfully and document remaining source coverage.

**Architecture:** Extend existing canonical climbing types and writer, with a
forward PostgreSQL migration. Both clients consume the same server metrics and
shared formatting. KAYA-specific decoding remains within the KAYA provider.

**Tech Stack:** TypeScript, Zod, Drizzle, PostgreSQL, Vitest.

**Spec:** [Design](../specs/2026-10-27-kaya-metadata-design.md).

## Global Constraints

- Stay on `sneaky-crab`; add no dependency or duplicate canonical storage.
- Unknown units remain unknown; never decode an outdoor category as degrees.
- TDD for behavior, real PostgreSQL tests for database semantics, web/mobile parity.
- Raw selected metadata remains available; provider aggregates and admin secrets are excluded.

## Review Focus

- Multiple grips count once per grip and once in each baseline.
- Missing and contradictory source metadata remain distinct.
- Refreshes preserve entry and attempt IDs and user-selected activity associations.
- Source categories never become numeric measurements.
- New schemas invalidate persisted responses and caches as required.

## Task 1: Canonical traits and consumers

- [x] Add failing model, formatting, analytics, UI, and PostgreSQL migration tests.
- [x] Extend angle union and replace scalar holds with collections in shared
  models, canonical schema/writer, repositories, web/mobile rendering, and fixtures.
- [x] Migrate existing values without retaining duplicate columns and update
  serving views/cache contracts. Verify focused suites and typechecks.
- [x] Review the contract and SQL before committing.

## Task 2: KAYA request coverage and source mapping

- [x] Validate observed fields against the authenticated API before requesting them.
- [x] Write failing client/provider and real PostgreSQL refresh regressions.
- [x] Request and retain tags, descriptions and other verified useful raw
  metadata, separate ascent grades and media; normalize explicit grips and
  outdoor angle categories. Preserve unknown tags and board units in raw data.
- [x] Verify client/provider and writer regressions; review source mappings.

## Task 3: Inventory, review, and release readiness

- [x] Update the KAYA contract and source inventory; record Mountain Project
  and theCrag metadata capabilities separately from current import coverage.
- [x] Run appropriate lint, type, unit/mobile, and PostgreSQL checks.
- [x] Obtain independent whole-branch review and resolve concrete findings.
- [ ] Commit and push; prepare a reviewable release and execute the authorized
  sync through the normal production path when the matching code is deployed.

## Task 4: Approved response versions and CI repair

- [x] Add failing V1/V2 contract and router tests, then implement version
  negotiation on the existing three tRPC paths and affected MCP tools.
- [x] Update both clients to request V2 and decode either strict wire version;
  test known legacy facts and current categorical/multiple-grip rendering.
- [x] Repair the hosted spelling, source-KAYA fixture and mutation failures;
  apply only the three explicitly approved statement-level migration exceptions.
- [ ] Run combined checks and fresh independent review, push the revision,
  verify hosted CI, then follow the normal maintenance release and KAYA sync.

The operator approved the versioned-response strategy and the three migration
exceptions on 2026-10-27. Production rollout still requires passing checks and
verification of both supported response versions.
