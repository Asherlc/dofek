# Medication Reminders TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship optional daily medication reminders with web/mobile parity, local iOS notification scheduling, and clear imported Taken/Skipped logging state.

**Behavior:** Users can create, edit, disable, and delete named daily reminders on web and mobile. Reminders persist in `fitness.user_settings` under `medicationReminders`. Enabling a reminder on iOS requests notification permission in context and schedules a local daily notification. Tapping the notification opens Settings focused on medication doses/reminders and shows the latest matching imported dose status.

**Scope:**
- Included: typed settings key, CRUD UI on web + mobile, logging-state display from existing `medicationDoseEvents.list`, local iOS notifications via `expo-notifications`, deep link to `/settings`.
- Non-goals: remote push/APNs, widgets, Watch, adherence scoring, inferred schedules, manual dose entry, Daily Brief / stale-source notifications (owned by other workspaces).

**Docs:** [docs/roadmap.md](../../roadmap.md) (Native Retention Surfaces), Expo [notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/), Apple [notification permission guidance](https://developer.apple.com/documentation/UserNotifications/asking-permission-to-use-notifications).

---

## Current Evidence

- Roadmap checkbox: “Support optional medication reminders with clear logging state.”
- Medication dose history already exists (read-only import list) on web and mobile Settings.
- `settings.set` only accepts `dashboardLayout`, `unitSystem`, and `whoop.wearLocation`.
- No `expo-notifications` dependency or scheduling code exists.

## Test Strategy

- Unit: shared Zod schema/helpers; notification sync (mocked `expo-notifications`); web/mobile panel CRUD and logging-state matching.
- Integration: `settings.set` accepts valid `medicationReminders` arrays and rejects malformed values.
- UI/mobile/web parity: equivalent Settings sections and Storybook stories on both platforms.

## File Structure

- Create: `packages/format/src/medication-reminders.ts` (+ test) — shared schema, settings key, logging-state helper
- Modify: `packages/format/package.json` — export path
- Modify: `packages/server/src/routers/settings.ts` — discriminated-union arm
- Modify: `packages/server/src/routers/settings.integration.test.ts` — accept/reject cases
- Create: `packages/web/src/components/MedicationRemindersPanel.tsx` (+ test, stories)
- Modify: `packages/web/src/pages/SettingsPage.tsx` — section
- Create: `packages/mobile/components/MedicationRemindersPanel.tsx` (+ test, stories)
- Create: `packages/mobile/lib/medication-reminder-notifications.ts` (+ test)
- Modify: `packages/mobile/app/settings.tsx` — section + focus params
- Modify: `packages/mobile/app/_layout.tsx` — notification response → router
- Modify: `packages/mobile/app.json` + `package.json` — plugin, permission string, dependency
- Modify: `docs/roadmap.md` — check off medication-reminders item when shipped

## Tasks

### Task 1: Shared schema and logging-state helper

**Files:**
- Create: `packages/format/src/medication-reminders.ts`
- Create: `packages/format/src/medication-reminders.test.ts`
- Modify: `packages/format/package.json`

- [ ] Write failing tests for schema parse/reject, `MEDICATION_REMINDERS_SETTINGS_KEY`, and `findLatestDoseLoggingState(reminders, events)`.
- [ ] Run `pnpm vitest run packages/format/src/medication-reminders.test.ts`.
- [ ] Confirm failure for missing module/exports.
- [ ] Implement schema + helpers; re-run until green.

### Task 2: Persist reminders via settings.set

**Files:**
- Modify: `packages/server/src/routers/settings.ts`
- Modify: `packages/server/src/routers/settings.integration.test.ts`

- [ ] Add failing integration cases: valid array round-trip; reject empty medication name, bad `localTime`, oversized array.
- [ ] Run `pnpm vitest run packages/server/src/routers/settings.integration.test.ts --project integration` (or workspace integration command).
- [ ] Extend `settingInputSchema` with `medicationReminders` using shared schema.
- [ ] Confirm tests pass.

### Task 3: Web reminders panel

**Files:**
- Create: `packages/web/src/components/MedicationRemindersPanel.tsx`
- Create: `packages/web/src/components/MedicationRemindersPanel.test.tsx`
- Create: `packages/web/src/components/MedicationRemindersPanel.stories.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`

- [ ] Write failing UI tests for empty state, add/edit/disable/delete, and logging-state badge from dose events.
- [ ] Run `pnpm vitest run packages/web/src/components/MedicationRemindersPanel.test.tsx`.
- [ ] Implement panel with optimistic `settings.get` / `settings.set` (Whoop wear-location pattern).
- [ ] Wire Settings section above Medication Doses; add Storybook stories.

### Task 4: Mobile reminders panel + local notifications

**Files:**
- Create: `packages/mobile/components/MedicationRemindersPanel.tsx` (+ test, stories)
- Create: `packages/mobile/lib/medication-reminder-notifications.ts` (+ test)
- Modify: `packages/mobile/app/settings.tsx`, `app/_layout.tsx`, `app.json`, `package.json`

- [ ] Write failing tests for panel CRUD/logging state and notification schedule/cancel/permission-on-enable.
- [ ] Add `expo-notifications@57.0.7`, plugin, and `NSUserNotificationsUsageDescription`.
- [ ] Implement sync helper: request permission only when enabling; daily trigger by hour/minute; cancel disabled/deleted by reminder id; deep-link data to `/settings?focus=medicationReminders`.
- [ ] Wire Settings section + notification response listener to navigate to Settings.
- [ ] Run mobile unit tests for new files.

### Task 5: Final verification and ship

- [ ] Run `pnpm lint`, package typechecks, and relevant unit tests.
- [ ] Check roadmap medication-reminders item.
- [ ] Commit, push, open PR against `main`, monitor CI and review feedback.
