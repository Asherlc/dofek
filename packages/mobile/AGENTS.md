# Mobile Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Architectural Mandates
- **Dual-Platform Parity**: Every UI change must be implemented here and in `dofek-web`.
- **Background Sync**: Be extremely cautious with `lib/background-*` logic. Uses `BackgroundRefreshModule` to schedule `com.dofek.accelerometer-refresh` tasks.
- **Native Modules**: Domain logic for BLE (`WhoopBleModule`) and HealthKit is implemented in Swift. TypeScript only provides the bridge via Expo Modules.

### UI Development
- **Storybook**: Every component MUST have a `.stories.tsx` file (lives in `.storybook` and `.rnstorybook`).
- **Charts**: Use `react-native-svg` for all chart implementations.
- **Navigation**: Uses Expo Router. Screen paths map to `app/`.

### Native Config Consistency
- **app.json must stay in sync with the filesystem**: When removing or renaming files in `plugins/`, `native/`, or `targets/`, update `app.json` in the same commit. Specifically: plugin paths in `expo.plugins`, pod paths in `expo-build-properties` `extraPods`, and target configs under `@bacons/apple-targets`. A mismatch causes `expo prebuild` to crash, breaking all iOS/watchOS CI jobs.
- **iOS-only HealthKit types in Swift packages**: When adding `HKClinicalType` identifiers (or any other iOS-only HealthKit type) to a Swift package that also targets macOS (e.g. `Package.swift` has `.macOS(...)` in `platforms`), wrap the block in `#if os(iOS)`. Types like `clinicalNoteRecord` and `coverageRecord` exist only on iOS and cause compile errors on macOS, which breaks Swift tests and Periphery scans that run on macOS CI runners.
- **metro.config.js**: Do not add packages to `metro.config.js` that are not listed in `package.json`. The Metro bundle CI job (`pnpm expo export --platform ios`) runs on a clean install and will crash immediately if a required module is missing.

### Testing Strategy
- **Vitest**: Use for component and hook unit tests.
- **Mocks**: Mock the `tRPC` and native modules in isolation tests. See `test-setup.ts`.
- **Native Tests**: Run XCTest suites for Swift modules.

### Error Handling
- **Telemetry**: Every catch block MUST call `captureException` from `./lib/telemetry`.
- **Sentry**: Ensure `sentry.properties` is configured correctly for native crash reports.
