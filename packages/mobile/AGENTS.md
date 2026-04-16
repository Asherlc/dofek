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

### Testing Strategy
- **Vitest**: Use for component and hook unit tests.
- **Mocks**: Mock the `tRPC` and native modules in isolation tests. See `test-setup.ts`.
- **Native Tests**: Run XCTest suites for Swift modules.

### Error Handling
- **Telemetry**: Every catch block MUST call `captureException` from `./lib/telemetry`.
- **Sentry**: Ensure `sentry.properties` is configured correctly for native crash reports.
