# Mobile Storybook RNGH Release Bundle TDD Plan

**Goal:** Make the on-device mobile Storybook produce and launch a Release iOS bundle against React Native 0.86 without a local renderer shim or Metro compatibility alias.

**Behavior:** With `EXPO_PUBLIC_STORYBOOK_ENABLED=true`, Metro resolves the on-device Storybook dependency graph, Xcode embeds the resulting bundle in a signed Release Simulator app, and the app opens to visible Storybook UI.

**Scope:** Issue [#2203](https://github.com/Asherlc/dofek/issues/2203) only. Includes the canonical Expo-compatible `react-native-gesture-handler` dependency, removal of the project-wide Metro condition override that makes CommonJS load ESM helpers, the mobile lockfile graph, executable Metro and Xcode Release validation, and the production incident baseline. Excludes a Gesture Handler 3 API migration, Metro aliases, copied React Native renderer shims, generated `ios/` files, web Storybook behavior, and unrelated Apple team configuration.

**Docs:** Expo SDK 57 recommends [`react-native-gesture-handler` `~2.32.0`](https://docs.expo.dev/versions/v57.0.0/sdk/gesture-handler/). Gesture Handler's official compatibility table supports React Native 0.84 through 0.86 on the 2.32 line and React Native 0.83 through 0.86 on 3.1.x; see the [installation requirements](https://docs.swmansion.com/react-native-gesture-handler/docs/fundamentals/installation/).

---

## Current Evidence

- Failing step:
  `CI=1 EXPO_PUBLIC_STORYBOOK_ENABLED=true EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:3100 EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id pnpm --dir packages/mobile exec expo export --platform ios`
- First fatal line:
  `Error: Unable to resolve module react-native/Libraries/Renderer/shims/ReactNative from .../react-native-gesture-handler/src/RNRenderer.ts: react-native/Libraries/Renderer/shims/ReactNative could not be found`
- Causal chain: the on-device Storybook UI imports `react-native-gesture-handler` 2.30.1. That release's `RNRenderer.ts` imports a renderer shim that React Native 0.86 no longer ships. Metro first warns that React Native's export resolves to nonexistent `Libraries/Renderer/shims/ReactNative.js`, then exhausts file-based resolution and fails the bundle.
- Current registry evidence: `react-native-gesture-handler` publishes `3.1.0` as `latest` and `2.32.0` as the current legacy line. Although 3.1 supports React Native 0.86, Expo SDK 57 recommends `~2.32.0`, and this repository runs `expo install --check` in mobile CI. The minimum framework-compatible fix is therefore the latest Expo-recommended 2.32 release, not a cross-cutting Gesture Handler 3 migration.
- Published-package evidence: `react-native-gesture-handler@2.32.0` replaces the failing `RNRenderer` module with `getShadowNodeFromRef` and contains no import of `Libraries/Renderer/shims/ReactNative`.
- After the renderer-shim bundle failure was fixed, the signed Release app
  installed and launched but Storybook failed during JavaScript initialization
  with `[runtime not ready]: TypeError: Object is not a function`. The source
  map resolves the first frame to
  `@testing-library/dom/dist/pretty-dom.js:12:46`, where CommonJS invokes
  `_interopRequireDefault(...)`.
- The mobile Metro configuration globally set `unstable_conditionNames` to
  `["react-native", "import", "require", "default"]`. That made the CommonJS
  `require("@babel/runtime/helpers/interopRequireDefault")` resolve to
  `helpers/esm/interopRequireDefault.js`; `require()` therefore returned an ESM
  namespace object instead of the callable CommonJS helper. Expo SDK 57's
  [Metro configuration](https://github.com/expo/expo/blob/a4789f1e53353f4929b0baddcfe5a7c622b99c71/packages/%40expo/metro-config/src/ExpoMetroConfig.ts#L302-L309)
  supplies `react-native` as a native platform condition without adding this
  project-wide override, while Storybook's
  [10.5.3 Metro wrapper](https://github.com/storybookjs/react-native/blob/v10.5.3/packages/react-native/src/metro/withStorybook.ts#L270-L280)
  requests `import` narrowly for Storybook and UUID packages. Metro's
  [package-exports documentation](https://metrobundler.dev/docs/package-exports/)
  explains that it selects `import` or `require` from the source operation and
  warns that global export conditions are asserted for every resolution.
- Upgrading `@storybook/react-native` from 10.5.3 to 10.5.4 or setting
  `reactNative.playFn: false` cannot fix this second failure. The release diff
  contains no relevant runtime change, and an executable diagnostic bundle
  retained the same `storybook/test -> @testing-library/dom` path.
  `react-native-reanimated` and `react-native-safe-area-context` are not in the
  fatal initialization stack.

## Test Strategy

- Unit: none. This is native dependency and Metro module-resolution behavior,
  and no existing behavioral test owns `metro.config.js`; repository guidance
  forbids creating a dedicated static-config assertion.
- Integration: use the real Metro dependency graph as the red/green executable test. The exact Storybook-enabled iOS export above must fail on 2.30.1 and pass on 2.32.0.
- Native/Release: generate a clean native project, build the signed `Dofek` Release scheme for the named iOS Simulator through XcodeBuildMCP, install and launch the app, and verify visible Storybook UI rather than only process startup.
- Regression gates: run Expo's dependency compatibility check, mobile typecheck/lint/tests, the normal mobile Metro export, and repository pre-push checks.

## File Structure

- Modify `packages/mobile/package.json` - declare the native runtime dependency at the exact Expo-compatible version.
- Modify `packages/mobile/metro.config.js` - use Expo's platform-aware package
  export conditions instead of forcing the ESM `import` condition globally.
- Modify `pnpm-lock.yaml` - resolve every mobile Storybook and Expo consumer to the canonical dependency.
- Modify `docs/production-incident-baseline.md` - retain root cause, evidence, fix, validation, and remaining risk.

## Tasks

### Task 1: Capture the Failing Executable Bundle

- [x] Generate `.rnstorybook/storybook.requires.ts`.
- [x] Run the exact Storybook-enabled iOS export command.
- [x] Confirm Metro fails at the removed React Native renderer shim and record the first fatal line.
- [x] Verify the import chain originates in the on-device Storybook UI through Gesture Handler 2.30.1.

### Task 2: Implement the Minimum Canonical Dependency Fix

- [x] Add exact `react-native-gesture-handler@2.32.0` to `packages/mobile` production dependencies.
- [x] Regenerate the frozen pnpm lockfile without overrides, patches, aliases, or copied shims.
- [x] Run `pnpm --dir packages/mobile exec expo install --check`.
- [x] Re-run the exact Storybook-enabled iOS export and confirm it passes.

### Task 3: Smoke-Test the Signed Storybook Release App

- [x] Generate Storybook requirements and run a clean Expo iOS prebuild with Storybook enabled.
- [x] Use XcodeBuildMCP to build the `Dofek` scheme in Release for simulator `691FA5C5-A87C-4520-9864-547E9B28A3D6` with local ad-hoc signing.
- [x] Install and launch the generated `.app`.
- [x] Capture the launch-time `Object is not a function` failure and source-map
  it to the Babel helper's incorrect ESM resolution.
- [x] Remove the global Metro condition override while retaining package exports
  and the pnpm-symlink resolver.
- [x] Rebuild, install, and launch the corrected Release app.
- [x] Capture the rendered Storybook `Pages/Login` story canvas and confirm the
  runtime log contains no JavaScript fatal or exception.
- [x] Stop the app and confirm generated native files leave no tracked source diff.

### Task 4: Final Verification and Incident Record

- [x] Run mobile lint, typecheck, all mobile tests, and the exact Storybook
  Release export.
- [x] Append the evidence-backed incident entry to `docs/production-incident-baseline.md`.
- [x] Run `git diff --check` and review the complete diff against `origin/main`.
- [ ] Commit, push, open a PR with `Fixes #2203`, and link the issue and PR in both directions.
- [ ] Monitor required checks and reviews, address every actionable finding, and merge only after all gates permit.
