# Push Provider Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Present automatic provider updates accurately on web and mobile and open a verified PR.

**Architecture:** Reuse `push_ingest` processing operations for actual push jobs and query their successful output-bearing ingestion events. Keep polling history and freshness unchanged; shared presentation distinguishes push updates using the provider capability.

**Tech Stack:** TypeScript, Drizzle/Postgres, React, React Native, Vitest.

**Spec:** [Approved design](../specs/2026-10-24-push-provider-status-design.md).

## Global Constraints

- Current branch only; no branch switching, dependencies, new environment variables, or new storage.
- `lastProcessedUpdateAt: string | null` describes successful push ingestion with emitted output.
- Shared `ProviderSyncHistory` accepts optional `pushOnly` and `lastProcessedUpdateAt`; `providerSyncLogPresentation` accepts optional `pushOnly`.
- Push recent logs and paginated update history exclude historical polling and no-output successes; failed ingestion remains visible.
- Both clients preserve authorization-specific reconnect behavior and mobile BLE semantics.
- Write failing behavior tests first; database semantics require a real Postgres integration test.

## Review Focus

- No-output/lifecycle jobs and legacy polling must not advance the update timestamp (Task 1).
- User isolation and failed-then-successful retry outcomes must remain correct (Task 1).
- Ongoing downstream processing must not be replaced by an ingestion-success banner (Task 2).
- Push processing errors must retain their cause without impossible retry or reconnect guidance (Tasks 1–3).
- Missing history is neutral and mobile BLE retains its distinct behavior (Tasks 2–3).

### Task 1: Durable push update evidence and API

**Files:** `src/jobs/sync-processing-operation.ts`, server sync/provider-detail repositories and routers, processing alerts, and adjacent unit/integration tests.

**Interfaces:** Produce required nullable `lastProcessedUpdateAt` in `sync.providers`; reuse existing recent/history log shapes for `push_ingest` outcomes. Preserve polling fields and scheduled freshness.

- [x] Add and run failing unit tests for push operation classification and safe alert guidance; add/run a real database fixture testing success with output, no output, failure, legacy polling, other users, and retry ordering.
- [x] Classify actual push webhook work with existing `push_ingest`; expose output-bearing ingestion success times and truthful push-only history from the processing ledger.
- [x] Run backend focused unit and integration suites; review query and authorization behavior before integration.

### Task 2: Shared presentation and web

**Files:** `packages/providers-meta/src/{sync-card-summary,sync-log-presentation,processing-status}.ts`, their tests, provider README, and web provider card/detail/history/processing components, tests, and stories.

**Interfaces:** Consume `pushOnly`, nullable `lastProcessedUpdateAt`, push recent logs, and operation kind `push_ingest`. Export existing presentation functions with additive capability inputs.

- [x] Add/run failing tests for neutral first-update state, processed timestamp, push success/error/degraded copy, actual failure details, and newer downstream processing preservation.
- [x] Implement shared presentation and web rendering with capability-aware copy, history/accessibility labels, and no manual retry instructions for push failures.
- [x] Run focused tests, update stories, and document the timestamp contract with links to source implementations.

### Task 3: Mobile parity

**Files:** Mobile provider card/detail/history/processing components, adjacent tests or `app-tests`, stories and fixtures as needed.

**Interfaces:** Consume Task 1's provider field and Task 2's shared capability-aware presentation functions.

- [x] Add/run failing mobile tests for first update, retained last processed time, processing failure, update history/disclosure accessibility, and BLE-specific behavior.
- [x] Implement the approved wording and data semantics using shared helpers, retaining real server errors and connection health.
- [x] Run focused mobile suites and review parity with the web surfaces.

### Task 4: Review, verification, and PR

- [x] Independently review each implementation scope and the full diff; resolve correctness findings with reproductions.
- [x] Run full lint, root/server/web/mobile typechecks, unit/mobile tests, and relevant database integration tests; visually inspect actual provider stories on web.
- [ ] Commit and automatically push the current branch, open the PR with a body file, and monitor required CI checks and feedback to completion.
- [ ] Report the PR, validation, any limitations, and a brief retrospective. Do not merge.
