# Irregular Cycle History and Editing TDD Plan

**Goal:** Keep cycle history correctable while withholding phase estimates when the recorded history is too sparse or irregular to support a regular-cycle model.

**Behavior:** The server classifies the current cycle estimate as unavailable for sparse, irregular, or stale history and supplies the explanation rendered by both clients. A user can edit a period by its stable ID, including correcting its date, or explicitly confirm deletion of an erroneous entry on web and iOS.

**Scope:** Reuse the canonical `fitness.menstrual_period` rows and their stable IDs; add no duplicate storage or inferred facts. Add user-scoped update/delete repository and tRPC operations, server-owned estimate-availability labels, and equivalent web/mobile controls. This does not add fertility predictions, diagnosis, cycle-day bleeding granularity, or provider ingestion.

**Docs:**

- [ACOG defines adult cycles outside 21–35 days and cycle-length variation above 7–9 days as abnormal](https://www.acog.org/womens-health/faqs/abnormal-uterine-bleeding).
- [ACOG cautions that a 28-day calendar assumption does not account for irregular cycle length or variable ovulation timing](https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2017/05/methods-for-estimating-the-due-date).
- [Apple Health asks users to verify and correct logged history when it detects cycle deviations](https://support.apple.com/en-gb/guide/iphone/iph1a4a00aa0/26/ios/26).

---

## Current Evidence

- `MenstrualCycleRepository.getCurrentPhase()` substitutes a generic 28-day cycle with zero completed intervals and averages every completed interval without deciding whether the history is sparse or irregular.
- `fitness.menstrual_period` already has a stable UUID primary key and a per-user start-date uniqueness constraint, so corrections and deletions need repository operations rather than a schema migration.
- The tRPC router exposes only `logPeriod`, while web and mobile render history as read-only rows.

## Test Strategy

- Unit: cover estimate availability states, ID- and user-scoped update/delete mapping, validation, cache invalidation, and client mutation/error behavior.
- Integration: execute date correction and deletion against PostgreSQL, including user isolation and the unique corrected start-date constraint.
- UI/mobile/web parity: verify both clients render server-supplied sparse/irregular explanations and offer equivalent edit, cancel, delete-confirm, and retry behavior.

## File Structure

- Modify: `packages/server/src/repositories/menstrual-cycle-repository.ts` and colocated tests — classification and canonical mutations.
- Modify: `packages/server/src/routers/menstrual-cycle.ts` and colocated tests — validated API operations and cache invalidation.
- Modify: `packages/web/src/routes/cycle.tsx` and colocated tests — accessible inline editing and confirmed deletion.
- Modify: `packages/mobile/app/cycle.tsx`, its tests, and story — equivalent native controls and fixtures.
- Modify: `packages/server/README.md` — document the estimate-availability and correction contract with primary citations.

## Tasks

### Task 1: Add Failing Server Tests

- [ ] Add repository unit/integration cases for sparse, irregular, and stale histories and for user-scoped correction/deletion.
- [ ] Add router cases for valid/invalid corrections, missing rows, deletion, and cache invalidation.
- [ ] Run `rtk pnpm test -- --run packages/server/src/repositories/menstrual-cycle-repository.test.ts packages/server/src/routers/menstrual-cycle.test.ts`.
- [ ] Confirm failures identify the missing status and mutation behavior.

### Task 2: Implement the Server Contract

- [ ] Withhold a phase estimate until at least three completed intervals exist.
- [ ] Withhold it when an interval is outside 21–35 days or the observed range exceeds 9 days.
- [ ] Return a server-authored status label for no history, sparse history, irregular history, stale history, and an available estimate.
- [ ] Add update/delete methods constrained by both period ID and authenticated user ID.
- [ ] Run the focused unit and PostgreSQL integration tests and confirm they pass.

### Task 3: Add Failing Client Tests

- [ ] Add web and mobile tests for server-supplied uncertainty, date/end-date/notes correction, cancel, delete confirmation, mutation retry, telemetry, and targeted invalidation.
- [ ] Run `rtk pnpm test -- --run packages/web/src/routes/cycle.test.tsx packages/mobile/app/cycle.test.tsx`.
- [ ] Confirm failures identify the missing controls.

### Task 4: Implement Web and iOS Parity

- [ ] Add equivalent accessible history actions and forms to web and mobile.
- [ ] Preserve user-entered form state on failed writes and surface the server error.
- [ ] Update the mobile Storybook fixture for edit/delete operations.
- [ ] Run the focused client tests and Storybook checks.

### Task 5: Final Verification

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`, `rtk pnpm --dir packages/server tsc --noEmit`, and `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test` and the focused integration test through the repository Compose wrapper.
- [ ] Push, open a PR with `Fixes #2166`, address all review feedback, and merge only after required checks pass.
