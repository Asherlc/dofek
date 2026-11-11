# Remove Healthspan Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, preserving the user's direct-implementation authorization. Keep one independent final review.

**Goal:** Delete Healthspan across both clients, API, computation and derived storage.

**Architecture:** Remove feature-owned code and references, retain shared inputs, and use the existing forward-only ClickHouse migration mechanism for derived-table retirement.

**Tech stack:** TypeScript, React Native, tRPC/Zod, dbt/ClickHouse, Vitest.

**Spec:** [Approved removal direction](../specs/2026-11-09-remove-healthspan-design.md).

## Global constraints

- Stay on `kilter-board-used-location`; preserve the pushed Kilter implementation.
- Delete obsolete tests; add no feature-absence or static-configuration tests.
- Preserve raw measurements, shared models and historical migration bodies.
- No compatibility bridge, replacement scoring or new dependency.
- Validate before committing; automatically push each new commit.

## Review focus

- Recovery payload, access-window selection and remaining cards still work.
- Projection ordering and failure gates retain the cycling downstream models.
- Current schema/test setup no longer recreates the retired models.
- Shared sensor, body, sleep and cycling data remain usable.
- Current documentation and exports match the implementation.

### Task 1: Remove API, client and library consumers

**Files:** Healthspan router/query/scoring and types; mobile Recovery service/contract/screen/stories/tests; web dashboard layout/pair helpers; scoring/format package exports.

**Interfaces:** Mobile Recovery payload loses `healthspan`; the Healthspan router and package subpaths are removed. Other payload fields retain their shapes.

- [x] Delete Healthspan source/test modules and remove callers, payload fields and fixtures.
- [x] Update existing retained-behavior tests and run focused unit/mobile tests and all four typechecks; expect success.

### Task 2: Retire analytics models and storage

**Files:** Both Healthspan SQL models, processing dataset contracts, entrypoint model list, analytics orchestration tests and ClickHouse test helpers; new `0112_remove_healthspan.ts` and registry, with PostgreSQL journal boundary `0181_healthspan_retirement_boundary.sql` to select existing deployment maintenance mode before the drop.

**Interfaces:** Existing downstream cycling model sequence retains `cycling_threshold_history` and `cycling_activity_power_metrics`. Existing migration runner drops only the two retired derived tables.

- [x] Remove models/registrations/fixtures and obsolete scenarios; retain regression coverage for projection ordering and shared consumers.
- [x] Run executable ClickHouse integration suites and the new migration locally. Body/sensor tests pass; four broad router fixture setups remain blocked at the local memory ceiling, as recorded in the incident baseline. Migration application and reapplication pass.

### Task 3: Verify and publish

**Files:** Active analytics/scoring docs, testing/performance references and incident baseline.

- [x] Update current docs, preserving dated historical records.
- [x] Run full lint, typechecks, unit/mobile tier and analytics build; expect success.
- [x] Independently review the diff, fix material findings, commit and push.
