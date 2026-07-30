# Mobile More Navigation TDD Plan

> **Test-first workflow:** Write each failing test before its production change.

**Goal:** Give responsive web and native mobile users one clear More destination that exposes account settings, Breathwork, and Cycle tracking.

**Behavior:** Responsive web includes More in its primary navigation and `/more` presents accessible links to Account & settings, Breathwork, and Cycle tracking. Native mobile keeps its five primary tabs and presents a More action beside Alerts in every tab header; `/more` exposes the same destinations with native routing and accessibility semantics.

**Scope:** Issue [#2185](https://github.com/Asherlc/dofek/issues/2185) only. Web and native navigation, the new destination screens/routes, focused tests, and Storybook stories are included. Health-data behavior, tab hierarchy, a new navigation dependency, and a speculative shared navigation package are excluded.

**Docs:** [Web architecture](../../../packages/web/README.md), [mobile architecture](../../../packages/mobile/README.md), [TanStack Router links](https://tanstack.com/router/latest/docs/framework/react/guide/navigation/), [Expo Router navigation](https://docs.expo.dev/router/navigating-pages/), and [React Native accessibility roles](https://reactnative.dev/docs/accessibility#accessibilityrole).

---

## Current Evidence

- `packages/web/src/components/AppHeader.tsx` lists Overview through Reports but no Settings, Breathwork, Cycle, or More destination in the responsive menu.
- Web Settings is available only from the desktop-only user card; therefore a narrow viewport has no account/settings entry.
- Native Settings is exposed only from the Today header, Breathwork only from Recovery content, and Cycle tracking only from Settings.
- The native tab layout already contains five primary health domains. A global header action provides consistent discovery without displacing one of those domains or introducing a sixth tab.

## Chosen Design

- Add a real `/more` route on web and native mobile.
- Present exactly three destination entries: Account & settings, Breathwork, and Cycle tracking.
- Add More to the web navigation list so it appears in the mobile menu and desktop sidebar.
- Replace the Today-only native Settings header action with a More action in the shared tab header alongside Alerts.
- Keep each platform's static route metadata local; three labels do not justify a shared domain abstraction.

## Test Strategy

- Web navigation unit tests: More appears in the responsive navigation and points to `/more`.
- Web page unit tests: the More page exposes all three named destinations with link semantics and correct routes.
- Native tab-layout unit tests: the shared header exposes Alerts and More, and More navigates to `/more`.
- Native screen unit tests: all three destinations have link semantics and navigate to the expected Expo Router paths.
- Stories: add web and native More destination stories so the new UI state is reviewable.

## File Structure

- Modify `packages/web/src/components/AppHeader.tsx`, its colocated test, and story route fixture.
- Create `packages/web/src/pages/MorePage.tsx`, `MorePage.test.tsx`, and `MorePage.stories.tsx`.
- Create `packages/web/src/routes/more.tsx` and regenerate `packages/web/src/routeTree.gen.ts`.
- Modify `packages/mobile/app/(tabs)/_layout.tsx` and its colocated test.
- Create `packages/mobile/app/more.tsx`, `more.test.tsx`, and `more.stories.tsx`.
- Modify `packages/mobile/app/_layout.tsx` to register the More screen title.

## Tasks

### Task 1: Add Failing Web Navigation and Page Tests

- [ ] Add a failing AppHeader assertion for a More link to `/more`.
- [ ] Add a failing More page test for Account & settings, Breathwork, and Cycle tracking link targets and semantics.
- [ ] Run `rtk pnpm vitest run packages/web/src/components/AppHeader.test.tsx packages/web/src/pages/MorePage.test.tsx --project unit`.
- [ ] Confirm failures identify the missing navigation entry and page.

### Task 2: Implement the Minimal Web Destination

- [ ] Add More to the existing navigation metadata.
- [ ] Add the More page and `/more` route without adding a navigation dependency.
- [ ] Regenerate the TanStack route tree with `rtk pnpm --dir packages/web typecheck`.
- [ ] Add a Storybook story for the destination.
- [ ] Re-run the focused web tests and confirm they pass.

### Task 3: Add Failing Native Navigation and Screen Tests

- [ ] Extend the tab-layout test to require a global More action routing to `/more`.
- [ ] Add a failing screen test for all three accessible destination links and route pushes.
- [ ] Run `rtk pnpm test:mobile -- packages/mobile/app/(tabs)/_layout.test.tsx packages/mobile/app/more.test.tsx`.
- [ ] Confirm failures identify the missing header action and screen.

### Task 4: Implement the Minimal Native Destination

- [ ] Make the shared tab header render Alerts and More.
- [ ] Remove the Today-only Settings shortcut after the global More destination is available.
- [ ] Add and register the native More screen.
- [ ] Add a native Storybook story for the destination.
- [ ] Re-run the focused native tests and confirm they pass.

### Task 5: Final Verification and Delivery

- [ ] Run `rtk pnpm lint`.
- [ ] Run `rtk pnpm tsc --noEmit`.
- [ ] Run `rtk pnpm --dir packages/web typecheck`.
- [ ] Run `rtk pnpm --dir packages/mobile typecheck`.
- [ ] Run `rtk pnpm test`.
- [ ] Build both web and mobile Storybooks if the environment supports their browser/native bundling prerequisites.
- [ ] Review the diff for web/mobile parity, link semantics, the unchanged five-tab hierarchy, and absence of duplicate navigation tooling.
- [ ] Commit, push, open a PR with `Fixes #2185`, link it from the issue, monitor checks and reviews, address every actionable item, and merge only when all required gates permit.
