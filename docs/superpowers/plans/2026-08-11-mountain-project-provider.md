# Mountain Project Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync a connected user's public Mountain Project tick export into canonical climbing activities.

**Architecture:** A small `@dofek/mountain-project` client fetches and decodes the unauthenticated CSV export. `MountainProjectProvider` turns valid YDS/V-scale rows into crag-day activities, reconciles the complete authoritative list, and emits one degradation for unsupported grades.

**Tech Stack:** TypeScript, Vitest, MSW, Drizzle, existing provider activity synchronization helpers.

## Global Constraints

- Use public tick-export only; never collect credentials or introduce login/upload/enrichment flows.
- Store the profile ID as the manual-token access token after live export validation.
- Preserve raw source fields, use canonical climbing grades, and reconcile only after a complete successful fetch.
- Keep client and provider modules independently testable; use MSW for network integration tests.

---

### Task 1: Mountain Project client

**Files:** `packages/mountain-project-client/src/client.ts`, `ticks.ts`, `grades.ts`, and colocated tests.

- [ ] Write failing tests for profile ID parsing, robust CSV decoding, and grade normalization.
- [ ] Implement the CSV client, row decoder, profile parser, and grade normalizer.
- [ ] Run package tests and typecheck.

### Task 2: Provider transformation and sync

**Files:** `src/providers/mountain-project.ts` and `src/providers/mountain-project.test.ts`.

- [ ] Write failing tests for sent mapping, null attempt count, crag-day grouping, repeat-lap IDs, and aggregated unsupported grades.
- [ ] Implement transformation, token validation, full-list upserts, and absence reconciliation.
- [ ] Run provider tests and auth-policy tests.

### Task 3: Registration and documentation

**Files:** provider registries, root exports, metadata, queue config, onboarding guide if present, `docs/mountain-project.md`.

- [ ] Register the provider in every execution path and add human-facing metadata.
- [ ] Document the observed unofficial API contract, scope, known risks, and no-auth design.
- [ ] Run targeted typechecks.

### Task 4: Database integration and verification

**Files:** `src/providers/mountain-project-sync.integration.test.ts` and fixtures.

- [ ] Write an MSW-backed real-DB sync test for insertion, idempotency, and tombstoning.
- [ ] Run lint, unit tests, integration tests, affected package typechecks, and inspect the final diff.
- [ ] Commit and push the verified implementation.
