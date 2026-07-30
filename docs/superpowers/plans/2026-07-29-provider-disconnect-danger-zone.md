# Provider Disconnect Danger Zone TDD Plan

> **For agentic workers:** Follow this plan test-first. Do not create a second issue; implementation belongs to [#2183](https://github.com/Asherlc/dofek/issues/2183).

**Goal:** Make provider disconnection a deliberate, clearly explained deauthorization action on web and mobile while retaining already imported Dofek records.

**Behavior:** Disconnecting a named provider revokes/removes its authorization and stops future syncs without deleting imported records. A separate Delete All Data action remains the only complete provider-data erasure path and remains available after disconnect when the authenticated user demonstrably owns retained records.

**Scope:** Server authorization/deletion ownership semantics, shared layman-readable wording, one separated Danger Zone on each client, accessible confirmation and pending/error behavior, focused Storybook states, and legal-facing copy. This does not add a second deletion mechanism or change the canonical outbox/analytics erasure pipeline.

**Docs:** [`packages/providers-meta/README.md`](../../../packages/providers-meta/README.md), [`packages/server/README.md`](../../../packages/server/README.md), [`packages/web/README.md`](../../../packages/web/README.md), [`packages/mobile/README.md`](../../../packages/mobile/README.md)

---

## Current Evidence

- Web renders Disconnect beside routine sync controls (and inside the push-only sync card) using an inline “Are you sure?” prompt.
- Mobile renders Disconnect below Delete All Data with a generic native alert and a generic fallback error.
- `providerDetail.disconnect` currently best-effort revokes upstream tokens and then deletes provider-owned PostgreSQL records, credentials, and `provider_connection`.
- The existing `deleteProviderAuthorization()` transaction already removes webhook subscriptions, OAuth credentials, and `provider_connection` while preserving imported records.
- The canonical `requestProviderDataDeletion()` path deletes PostgreSQL records, advances the metric-stream generation fence, and emits the outbox event used for ClickHouse and derived-analytics erasure.
- Privacy and terms copy describes Disconnect as stopping future sync while account data is retained.

## Test Strategy

- Unit: shared disconnect/deletion copy, authorization-only route orchestration, exact server errors, named confirmations, pending single-flight behavior, cancel-first focus, Escape/back behavior, and visual separation.
- Integration: real Postgres proves authorization state is removed while imported provider rows remain; disconnected users can request canonical deletion only for their own retained rows; another user/provider cannot use that path. Real ClickHouse proves active retained metric-stream rows can establish ownership and tombstoned rows cannot.
- UI parity: web and mobile render the same shared impact contract and equivalent default, confirming, pending, error, disconnected-with-data, and no-data states.

## File Structure

- Create: `packages/providers-meta/src/provider-disconnect.ts` — shared presentation contract and named copy.
- Create: `packages/providers-meta/src/provider-disconnect.test.ts` — exact shared wording behavior.
- Modify: `packages/providers-meta/package.json`, `packages/providers-meta/README.md` — expose and document the contract.
- Modify: `src/db/tokens.integration.test.ts` — executable authorization-only retention proof.
- Modify: `packages/server/src/repositories/provider-detail-repository.ts` — narrowly prove connection or retained-record ownership for deletion.
- Modify: `packages/server/src/repositories/provider-detail-repository.test.ts` and `.integration.test.ts` — PostgreSQL and ClickHouse ownership tests.
- Modify: `packages/server/src/routers/provider-detail.ts` and `.test.ts` — use `deleteProviderAuthorization`, semantic errors, and canonical delete authorization.
- Replace: web/mobile provider delete controls with one `ProviderDangerZone` component per platform, colocated tests and stories.
- Modify: web/mobile provider detail screens — remove routine-control disconnect surfaces and render the single Danger Zone.
- Modify: `packages/web/src/routes/privacy.tsx`, `packages/web/src/routes/terms.tsx` — keep public copy explicit and consistent.

## Tasks

### Task 1: Lock the Shared Product Contract

- [ ] Add failing `@dofek/providers` tests for named disconnect title/action, retained-record impact, and the distinction between Disconnect and Delete All Data.
- [ ] Run `rtk pnpm exec vitest run --project unit packages/providers-meta/src/provider-disconnect.test.ts` and confirm RED.
- [ ] Implement the smallest pure presentation contract and package export.
- [ ] Run the focused test and `rtk pnpm --dir packages/providers-meta typecheck`; confirm GREEN.

### Task 2: Make Disconnect Authorization-Only

- [ ] Extend the real-database token integration test to seed a provider-owned activity before `deleteProviderAuthorization()` and prove the connection, webhook, and credentials are removed while the activity remains.
- [ ] Change route unit tests first so Disconnect must call `deleteProviderAuthorization()` and must not call provider-record deletion.
- [ ] Run the focused unit and integration tests and confirm RED for the old route behavior.
- [ ] Replace the route’s record deletion with the existing canonical authorization deletion function and return a semantic `TRPCError` for an unowned connection.
- [ ] Run the focused tests and confirm GREEN.

### Task 3: Authorize Canonical Deletion After Disconnect

- [ ] Add failing PostgreSQL integration tests proving a disconnected user with retained rows is eligible, another user is not, and an accepted request emits the existing provider-data-deletion outbox event.
- [ ] Add failing ClickHouse integration coverage proving active retained metric-stream rows establish ownership while tombstoned-only history does not.
- [ ] Add route unit tests proving `deleteAllData` accepts a connected provider or demonstrably owned retained records and rejects every other case with the exact actionable server message.
- [ ] Run `rtk pnpm exec vitest run --project unit packages/server/src/repositories/provider-detail-repository.test.ts packages/server/src/routers/provider-detail.test.ts` and the matching integration files; confirm RED.
- [ ] Implement one narrow repository ownership predicate over user-scoped canonical provider tables and deduplicated active metric-stream rows; wire the route to it without a fallback authorization shortcut.
- [ ] Re-run the focused tests and confirm GREEN.

### Task 4: Build the Web Danger Zone Test-First

- [ ] Add failing component/page tests for one visually separated Danger Zone, shared retained-data impact, a named provider modal, Cancel initial focus and focus restoration, Escape while idle, blocked dismissal while pending, exact server error text, and single-flight confirmation.
- [ ] Run `rtk pnpm exec vitest run --project unit packages/web/src/components/ProviderDangerZone.test.tsx packages/web/src/pages/ProviderDetailPage.test.tsx`; confirm RED.
- [ ] Replace inline disconnect surfaces with one `ProviderDangerZone`, reusing `ModalDialog` and the existing canonical Delete All Data workflow.
- [ ] Add/update Storybook stories for default, confirmation, pending, error, disconnected-with-data, and no-data states.
- [ ] Re-run focused tests and web typecheck; confirm GREEN.

### Task 5: Build the Mobile Danger Zone Test-First

- [ ] Add failing component/screen tests for the same shared copy, named confirmation, cancel-first ordering/focus, hardware-back dismissal while idle, blocked dismissal while pending, exact server error text, and single-flight confirmation.
- [ ] Run `rtk pnpm exec vitest run --project mobile packages/mobile/components/ProviderDangerZone.test.tsx packages/mobile/app/providers/[id].test.tsx`; confirm RED.
- [ ] Replace the generic alert and separate destructive buttons with one mobile `ProviderDangerZone`.
- [ ] Add/update mobile Storybook stories for default, confirmation, pending, error, disconnected-with-data, and no-data states.
- [ ] Re-run focused tests and mobile typecheck; confirm GREEN.

### Task 6: Documentation, Runtime Verification, and Delivery

- [ ] Update provider metadata docs and legal-facing privacy/terms copy to state that Disconnect retains imported records and Delete All Data erases them.
- [ ] Run focused formatting/lint, all touched package typechecks, unit/mobile tests, and database-backed integration tests through the workspace Compose wrapper.
- [ ] Runtime-verify web keyboard focus, responsive narrow/wide layouts, both destructive flows’ visual separation, loading, and server-error rendering.
- [ ] Runtime-verify mobile software-only behavior in Simulator only if component tests cannot validate a native modal/back/focus boundary.
- [ ] Commit and push each meaningful green slice.
- [ ] Open a PR with `Fixes #2183`, add the issue backlink, monitor all checks/reviews, address every actionable comment, and squash-merge only after required checks permit.
