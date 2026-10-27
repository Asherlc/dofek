# Provider Label And Provenance TDD Plan

**Goal:** Replace user-visible raw journal provider IDs with canonical human labels while preserving source IDs behind explicit diagnostic disclosure.

**Behavior:** Tracking entries and web/mobile Behavior Associations show server-resolved provider labels by default, expose contributing provider IDs only in accessible technical details, and share one provider identity resolver from `@dofek/providers`.

**Scope:** Shared provider metadata, journal and behavior-impact server response models, Tracking, Behavior Associations on web and mobile, focused tests, and existing stories. Non-goals: changing provider storage, journal ingestion, provider priority, association calculations, or unrelated provider presentation.

**Docs:** `packages/providers-meta/README.md`, `packages/providers-meta/src/providers.ts`, `packages/server/src/repositories/journal-repository.ts`, `packages/server/src/repositories/behavior-impact-repository.ts`, `packages/web/src/components/JournalPanel.tsx`, `packages/web/src/components/BehaviorImpactChart.tsx`, `packages/mobile/app/behavior-associations.tsx`.

---

## Current Evidence

- `JournalPanel` renders `entry.provider_id` directly, which exposes the review fixture ID `manual_review` on Tracking.
- `PROVIDER_LABELS` is the canonical shared provider-name map but does not include `manual_review`.
- `BehaviorImpactRepository` aggregates journal answers without returning the providers that contributed them, so neither client can explain association provenance.
- No other user-visible `manual_review` path exists outside seeded journal records and sync diagnostics.

## Test Strategy

- Shared unit tests: canonical provider provenance resolves `manual_review` to a human label and preserves its ID.
- Server unit tests: journal details and behavior associations contain server-resolved source objects, including deterministic multi-provider provenance.
- Web unit tests: Tracking and Behavior Associations render labels by default and reveal raw IDs only through accessible technical details.
- Mobile unit tests: Behavior Associations provides the same label-first provenance and accessible disclosure behavior.
- Stories: update existing Tracking and web/mobile Behavior Associations fixtures to cover labeled provenance and diagnostic detail.

## File Structure

- Modify: `packages/providers-meta/src/providers.ts` and `providers.test.ts` — canonical provider provenance.
- Modify: `packages/server/src/repositories/journal-repository.ts` and test — journal response source model.
- Modify: `packages/server/src/repositories/behavior-impact-repository.ts` and test — contributing source provenance.
- Modify: `packages/server/src/routers/behavior-impact.ts` and test — typed public response contract.
- Modify: `packages/web/src/components/JournalPanel.tsx`, test, and story — Tracking source presentation.
- Modify: `packages/web/src/components/BehaviorImpactChart.tsx`, test, and story — web association provenance.
- Modify: `packages/mobile/app/behavior-associations.tsx`, test, and story — mobile association provenance.

## Tasks

### Task 1: Add Failing Shared And Server Tests

- [x] Add tests for the canonical `manual_review` label and typed provenance resolver.
- [x] Add journal repository tests requiring a resolved source object instead of a top-level raw provider ID.
- [x] Add behavior-impact repository/router tests requiring sorted contributing source provenance.
- [x] Run `rtk pnpm vitest run packages/providers-meta/src/providers.test.ts packages/server/src/repositories/journal-repository.test.ts packages/server/src/repositories/behavior-impact-repository.test.ts packages/server/src/routers/behavior-impact.test.ts`.
- [x] Confirm failure for the missing source model and label.

### Task 2: Add Failing Web And Mobile Tests

- [x] Add Tracking assertions for the human source label and hidden-by-default diagnostic ID.
- [x] Add web Behavior Associations assertions for the same provenance behavior.
- [x] Add mobile Behavior Associations assertions for label-first presentation and an accessible disclosure control.
- [x] Run `rtk pnpm vitest run packages/web/src/components/JournalPanel.test.tsx packages/web/src/components/BehaviorImpactChart.test.tsx`.
- [x] Run `rtk pnpm test:mobile -- app/behavior-associations.test.tsx`.
- [x] Confirm failure for the missing label/provenance presentation.

### Task 3: Implement The Canonical Source Contract

- [x] Extend `@dofek/providers` with the `manual_review` label and one typed provider-provenance resolver.
- [x] Map journal entry rows and behavior-impact provider IDs to that resolver on the server.
- [x] Keep the provider ID nested in the source diagnostic model instead of exposing a top-level presentation field.
- [x] Preserve the current association calculation and deterministic source ordering.
- [x] Run the focused shared/server tests and confirm they pass.

### Task 4: Render Accessible Provenance On Both Clients

- [x] Render source labels by default on Tracking and web/mobile Behavior Associations.
- [x] Put raw provider IDs behind explicit, labeled technical-details controls.
- [x] Update existing stories with `manual_review` and multi-source fixtures.
- [x] Run the focused web/mobile tests and confirm they pass.

### Task 5: Final Verification And Delivery

- [x] Run `rtk pnpm lint`.
- [x] Run `rtk pnpm tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [x] Run `rtk pnpm --dir packages/mobile tsc --noEmit`.
- [x] Run `rtk pnpm test:changed`.
- [ ] Commit, push, open the linked PR with `Fixes #2155`, monitor exact-head checks and review feedback, and merge manually when every required gate passes.
