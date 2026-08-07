# Mobile Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Architectural Mandates
- **Dual-Platform Parity**: Every UI change must be implemented here and in `dofek-web`.
- **Background Sync**: Be extremely cautious with `lib/background-*` logic. Uses `BackgroundRefreshModule` to schedule `com.dofek.accelerometer-refresh` tasks.
- **Native Modules**: Domain logic for BLE (`WhoopBleModule`) and HealthKit is implemented in Swift. TypeScript only provides the bridge via Expo Modules.

### UI Development
- **Storybook**: `.storybook` and `.rnstorybook` contain Storybook configuration. Route stories live in `app-stories/`; component stories live beside their component under `components/`.
- **Charts**: Use `react-native-svg` for all chart implementations.
- **Navigation**: Uses Expo Router. Screen paths map to `app/`.
- **Expo Router route hygiene**: Never colocate tests, stories, fixtures, or helper-only files under `packages/mobile/app/`. Expo Router's `app` directory is exclusively for routes and attempts to treat non-route files there as routes ([Expo Router core concepts](https://docs.expo.dev/router/basics/core-concepts/#6-non-navigation-components-live-outside-the-srcapp-directory)), which can create extra iOS tabs/screens. Put route tests under `packages/mobile/app-tests/`, route stories under `packages/mobile/app-stories/`, and shared route fixtures under `packages/mobile/app-fixtures/`. If a file under `app/` is not a real route/layout/special Expo Router file, move it out instead of hiding it with `href: null`.
- **Query state handling**: Treat loading, error, and empty as separate UI states. Do not use `query.data ?? []` or similar fallbacks when `query.error` exists. Use `components/QueryStatePanel.tsx` for explicit error/empty/loading states on screens and cards.
- **Loading performance**: Follow `../../docs/performance/loading-performance-runbook.md` for slow screens. Do not blank visible previous/cached data during background refetches; use blocking loading only when no usable data exists, preserve server error messages, and keep sync/refresh invalidation targeted to affected query families.

### Native Config Consistency
- **app.json must stay in sync with the filesystem**: When removing or renaming files in `plugins/`, `native/`, or `targets/`, update `app.json` in the same commit. Specifically: plugin paths in `expo.plugins`, pod paths in `expo-build-properties` `extraPods`, and target configs under `@bacons/apple-targets`. A mismatch causes `expo prebuild` to crash, breaking all iOS/watchOS CI jobs.
- **iOS-only HealthKit types in Swift packages**: When adding `HKClinicalType` identifiers (or any other iOS-only HealthKit type) to a Swift package that also targets macOS (e.g. `Package.swift` has `.macOS(...)` in `platforms`), wrap the block in `#if os(iOS)`. Types like `clinicalNoteRecord` and `coverageRecord` exist only on iOS and cause compile errors on macOS, which breaks Swift tests and Periphery scans that run on macOS CI runners.
- **metro.config.js**: Do not add packages to `metro.config.js` that are not listed in `package.json`. The Metro bundle CI job (`pnpm expo export --platform ios`) runs on a clean install and will crash immediately if a required module is missing.

### Testing Strategy
- **Vitest**: Use for component and hook unit tests.
- **Mocks**: Mock the `tRPC` and native modules in isolation tests. See `test-setup.ts`.
- **Native Tests**: Run XCTest suites for Swift modules.
- **Simulator audits**: Prefer XcodeBuildMCP when configured. Build the
  `Dofek` scheme from `ios/Dofek.xcworkspace` for a booted iOS Simulator,
  install and launch the `.app`, then capture logs and screenshots while
  exploring real navigation paths. Do not count a successful compile, process
  launch, or Expo development-launcher screen as successful app UI execution.
- **Use the simulator-audit skill**: For a signed Release audit, read
  [`.agents/skills/ios-simulator-audit/SKILL.md`](../../.agents/skills/ios-simulator-audit/SKILL.md).
  Do not pass a global `-sdk iphonesimulator` to the multi-platform `Dofek`
  scheme, disable code signing, or blank `INFOPLIST_FILE`; each creates a false
  failure in the watch target, SecureStore, or CoreBluetooth path respectively.
- **Signed development manifests**: Because `app.json` configures an Expo
  Updates code-signing certificate, start Metro with the matching ignored
  private key via `--private-key-path`. Never commit or print that key. If the
  key is unavailable, report the exact manifest-signing blocker and ask before
  pivoting to a Release simulator build with an embedded bundle.
- **Simulator scope**: Do not infer BLE, motion-sensor, or background-delivery
  correctness from the Simulator; exercise those paths on physical hardware.

### Error Handling
- **Telemetry**: Every catch block MUST call `captureException` from `./lib/telemetry`.
- **Sentry**: Ensure `sentry.properties` is configured correctly for native crash reports.
