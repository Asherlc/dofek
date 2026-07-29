# iOS Dark Mode TDD Plan

**Goal:** Make the Dofek iOS interface follow the system Light or Dark
appearance without duplicating theme logic across screens and components.

**Behavior:** Existing mobile semantic surface and text roles resolve to the
light palette in Light Mode and the dark palette in Dark Mode. Major screens
and components can be reviewed in either appearance through the on-device
Storybook toolbar.

**Scope:** Update the iOS theme boundary, inverse text roles, focused tests,
and on-device Storybook preview. Preserve the current light appearance and
leave web Dark Mode to separately tracked issue #2186.

**Docs:** [Issue #2191](https://github.com/Asherlc/dofek/issues/2191),
[React Native `DynamicColorIOS`](https://reactnative.dev/docs/dynamiccolorios),
and [Storybook globals and decorators](https://storybook.js.org/docs/8/essentials/toolbars-and-globals).

---

## Current Evidence

- A signed Release build from `origin/main @ 2db1599f0` was installed on an
  isolated iPhone 17e Simulator running iOS 26.4.
- Switching that Simulator from Light to Dark changed the native status bar,
  but the Dofek login/error screen remained pixel-identical light sage.
- The native accessibility screen hash remained `1hq931f` across the
  appearance change.
- `packages/mobile/app.json` already declares
  `userInterfaceStyle: automatic`; `packages/mobile/theme.ts` instead maps all
  surface and text roles to fixed light-only strings.
- React Native Web Storybook builds and the on-device story catalog generates
  successfully. A Storybook-enabled iOS export is currently blocked before
  app code because
  [`react-native-gesture-handler@2.30.1` imports `ReactNative`](https://github.com/software-mansion/react-native-gesture-handler/blob/v2.30.1/packages/react-native-gesture-handler/src/RNRenderer.ts#L3)
  from a shim that is absent from the
  [React Native 0.86 renderer-shim directory](https://github.com/react/react-native/tree/v0.86.0/packages/react-native/Libraries/Renderer/shims).

## Test Strategy

- Unit: preserve the current light palette, require distinct dark surface
  roles, verify readable dark text contrast, and prove every semantic role is
  mapped through the adaptive color factory.
- iOS adapter: verify the native theme passes the expected light and dark
  variants to React Native's dynamic-color boundary.
- Mobile regression: run the full mobile Vitest project for the screens and
  components that consume the theme.
- Storybook: build React Native Web Storybook and generate the on-device story
  catalog after adding the global appearance control.
- Runtime: rebuild the signed Release app and capture the same real screen in
  both Simulator appearances.

## File Structure

- Create: `packages/mobile/theme-palette.ts` - light/dark semantic values and
  adaptive-role mapping.
- Create: `packages/mobile/theme.ios.ts` - native `DynamicColorIOS` adapter.
- Modify: `packages/mobile/theme.ts` - non-iOS light fallback.
- Create: `packages/mobile/theme-palette.test.ts` - palette and mapping tests.
- Create: `packages/mobile/theme.ios.test.ts` - iOS adapter tests.
- Modify: `packages/mobile/.rnstorybook/preview.tsx` - Light/Dark global
  appearance toolbar.
- Modify: inverse-label consumers - use one semantic inverse text role instead
  of a background or surface token.

## Tasks

### Task 1: Reproduce and add failing tests

- [x] Build, install, and launch the signed Release app on an isolated
  Simulator.
- [x] Capture Light and Dark evidence and confirm the fixed-light failure.
- [x] Add focused palette and iOS-adapter tests before implementation.
- [x] Run the tests and confirm they fail because the adaptive palette modules
  do not exist.

### Task 2: Implement the semantic theme boundary

- [x] Preserve the current light palette.
- [x] Add dark background, surface, divider, and text roles.
- [x] Map all roles through `DynamicColorIOS` in the iOS platform module.
- [x] Replace the seven background/surface-as-text call sites with
  `textInverse`.
- [x] Re-run the focused tests until green.

### Task 3: Add Storybook appearance coverage

- [x] Add one on-device Storybook global that switches the iOS system
  appearance.
- [x] Apply the adaptive background to the shared Storybook decorator so the
  existing major-screen and component stories can be reviewed in both modes.
- [x] Build the web Storybook and generate the on-device story catalog.

### Task 4: Verify and ship

- [x] Run mobile typecheck and the full mobile test project.
- [x] Export the iOS bundle to verify Metro selects the iOS platform theme.
- [x] Rebuild the signed Release app and capture correct Light/Dark runtime
  evidence.
- [ ] Run repository pre-push checks, commit, push, and open a PR with
  `Fixes #2191`.
- [ ] Monitor CI and review feedback, address every actionable item, and merge
  when required checks and reviews permit.
