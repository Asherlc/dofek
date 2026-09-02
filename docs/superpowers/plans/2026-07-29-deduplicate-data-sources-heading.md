# Deduplicate Data Sources Heading TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Settings connections tab one clear Data Sources heading and one canonical source-management entry point.

**Behavior:** Web Settings renders the outer `PageSection` title and subtitle once, while `DataSourcesPanel` renders provider state and sync actions without repeating the title. Mobile retains its existing single visible Data Sources section heading and provider-management action.

**Scope:** Remove only the redundant web component-local heading, preserve web sync controls and `/providers` redirect behavior, update the existing web story composition, and add a mobile parity assertion. Do not change routes, provider behavior, or mobile production UI.

**Docs:** [Issue #2175](https://github.com/Asherlc/dofek/issues/2175)

---

## Current Evidence

- `SettingsPage` wraps `DataSourcesPanel` in `PageSection title="Data Sources"`.
- `DataSourcesPanel` renders another `h3` with the same visible name, producing two adjacent headings in the real web composition.
- The web `/providers` index already redirects to the Settings connections tab.
- Mobile Settings renders one visible Data Sources section heading and one named card that opens `/providers`; its provider screen owns the management UI.

## Test Strategy

- Unit: Render `DataSourcesPanel` inside the real `PageSection` and require exactly one heading named Data Sources while preserving the available-sources region.
- UI/mobile/web parity: Strengthen the existing mobile Settings test to require exactly one visible Data Sources label; no mobile production change is expected.
- Storybook: Render the web panel story inside `PageSection` so review matches the production hierarchy.

## File Structure

- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx` - reproduce the duplicate heading through the public component composition.
- Modify: `packages/mobile/app/settings.test.tsx` - record the existing single-heading parity contract.
- Modify: `packages/web/src/components/DataSourcesPanel.tsx` - remove the redundant local heading while preserving sync actions.
- Modify: `packages/web/src/components/DataSourcesPanel.stories.tsx` - show the production section hierarchy.

## Tasks

### Task 1: Add Failing Tests

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.test.tsx`
- Modify: `packages/mobile/app/settings.test.tsx`

- [ ] Write the web composition test and mobile parity assertion.
- [ ] Run `rtk pnpm vitest run --project unit packages/web/src/components/DataSourcesPanel.test.tsx`.
- [ ] Confirm the web test fails because two Data Sources headings are rendered.
- [ ] Run `rtk pnpm vitest run --project mobile packages/mobile/app/settings.test.tsx`.
- [ ] Confirm the mobile parity assertion already passes.

### Task 2: Implement Minimal Fix

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.tsx`

- [ ] Remove the redundant component-local heading.
- [ ] Preserve the existing sync and full-sync buttons in the control row.
- [ ] Run `rtk pnpm vitest run --project unit packages/web/src/components/DataSourcesPanel.test.tsx`.
- [ ] Confirm the web test passes.

### Task 3: Update Review Fixture

**Files:**
- Modify: `packages/web/src/components/DataSourcesPanel.stories.tsx`

- [ ] Wrap the panel story in the same titled `PageSection` used by Settings.
- [ ] Run `rtk pnpm --dir packages/web build-storybook`.
- [ ] Confirm the production Storybook build passes.

### Task 4: Final Verification

- [ ] Run focused web and mobile tests.
- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/server tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web tsc --noEmit`.
- [ ] Run `rtk pnpm test`.
- [ ] Commit, push, open the linked PR, and monitor exact-head CI and review feedback through manual merge.
