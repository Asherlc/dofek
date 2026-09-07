# iOS Sentry Launch-Crash Implementation Plan

<!-- cspell:ignore xcframework XCFRAMEWORK -->

**Goal:** Ship an iOS build that does not call the crashing deprecated Sentry native startup API.

**Architecture:** Upgrade `@sentry/react-native` to the current supported SDK, which replaces the deprecated private iOS startup API and provides Sentry Cocoa 9.24.0. The iOS app and its Expo native modules use the SDK's single prebuilt XCFramework through `RNSentry`; the separate watch executable receives the same Sentry Cocoa release through Swift Package Manager.

**Tech Stack:** Expo SDK 57, React Native 0.86, CocoaPods, `@sentry/react-native` 8.24.0, Sentry Cocoa 9.24.0.

**Spec:** User-reported TestFlight launch crash, crash report `F8FC8194-CE27-40D5-BDAA-81B11178EFC7`.

## Global Constraints

- Maintain one canonical native Sentry implementation; do not mix source-built and prebuilt Sentry SDKs.
- Preserve native error reporting from HealthKit, watch-motion, and the watch app.
- Do not modify generated `packages/mobile/ios` files.
- Validate with a clean native generation and a simulator launch; TestFlight remains the physical-device release gate.
- Sentry React Native 8.23 migrated iOS internals away from the deprecated private SPI after the corresponding Cocoa SDK fix; 8.24.0 is the current release ([release notes](https://github.com/getsentry/sentry-react-native/releases/tag/8.23.0), [latest release](https://github.com/getsentry/sentry-react-native/releases/tag/8.24.0)).

---

### Task 1: Upgrade the canonical mobile Sentry SDK

**Files:**
- Modify: `packages/mobile/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `@sentry/react-native` Expo config plugin.
- Produces: React Native Sentry 8.24.0 with the fixed public iOS startup API path.

- [x] **Step 1: Capture the red failure evidence**

Use the supplied TestFlight crash report. It fails in `RNSentryInternal.appStartMeasurementHybridSDKMode.setter` called by `RNSentryStart updateWithReactFinals` before JavaScript starts.

- [x] **Step 2: Upgrade only `@sentry/react-native` to 8.24.0**

Run `pnpm update @sentry/react-native@8.24.0 --filter dofek-mobile`.

- [x] **Step 3: Confirm the installed native SDK no longer uses the private startup API**

Run `rg "PrivateSentrySDKOnly.appStartMeasurementHybridSDKMode" packages/mobile/node_modules/@sentry/react-native/ios` and require no match.

### Task 2: Use the single supported native Sentry framework

**Files:**
- Modify: `packages/mobile/plugins/with-ios-pod-settings.js`
- Modify: `packages/mobile/modules/health-kit/ios/ExpoHealthKit.podspec`
- Modify: `packages/mobile/modules/watch-motion/ios/ExpoWatchMotion.podspec`
- Modify: `packages/mobile/targets/DofekWatch/pods.rb`
- Create: `packages/mobile/plugins/with-watch-sentry-spm.js`
- Modify: `packages/mobile/app.json`

**Interfaces:**
- Consumes: Sentry React Native's prebuilt `Sentry.xcframework` and its generated CocoaPods search paths.
- Produces: the iOS executable links one Cocoa SDK framework through RNSentry, while the separate watch executable links Sentry 9.24.0 once through SwiftPM.

- [x] **Step 1: Remove the legacy source-only setting and direct 9.19.1 pod pins**

The newer official SDK rejects `SENTRY_USE_XCFRAMEWORK=0` because CocoaPods no longer publishes Sentry Cocoa after 9.19.1.

- [x] **Step 2: Configure custom iOS modules to depend on RNSentry and the watch target to depend on Sentry through SwiftPM**

Keep imports and native error reporting unchanged while using the official prebuilt SDK path.

- [x] **Step 3: Generate a clean iOS project and inspect its resolved Sentry topology**

Run the documented Expo prebuild with an isolated public test DSN. Require one Sentry Cocoa framework version and no source-built `Sentry` pod.

### Task 3: Validate native launch

**Files:**
- Modify: `docs/production-incident-baseline.md`

**Interfaces:**
- Consumes: generated `Dofek.xcworkspace` and a booted iOS simulator.
- Produces: native build and launch evidence for the Sentry initialization path.

- [ ] **Step 1: Build and launch the isolated Simulator artifact**

Use XcodeBuildMCP with the generated workspace, `Dofek` scheme, and an isolated bundle identifier. Capture runtime logs and a UI snapshot.

- [x] **Step 2: Run focused mobile typecheck and relevant native module tests**

Run `pnpm --dir packages/mobile typecheck`, `pnpm test:mobile -- packages/mobile/modules/watch-motion/index.test.ts`, and the HealthKit-focused mobile tests.

- [x] **Step 3: Record the incident evidence**

Append the crash signature, root cause, framework migration, verification output, remaining physical-device risk, and TestFlight follow-up to the production incident baseline.

- [ ] **Step 4: Request approval before commit and push**

After validation passes, request operator or workflow approval before committing the focused native migration and pushing the active branch to its configured remote.
