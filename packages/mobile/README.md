# dofek-mobile

The mobile app for Dofek. Built with Expo and React Native, with native Swift modules for HealthKit and WHOOP BLE synchronization.

## Core Features

- **HealthKit Sync**: Background synchronization of health and fitness metrics from iOS using `BackgroundRefreshModule` which registers `BGAppRefreshTask`.
- **WHOOP BLE Sync**: High-resolution sensor data capture (IMU - accelerometer + gyroscope) from WHOOP straps via `WhoopBleModule`.
- **Activity Recording**: Real-time GPS and sensor recording for workouts, utilizing native `CoreMotion` and `WatchMotion` modules.
- **Mobile Dashboard**: Simplified mobile-first health and recovery tracking with SVG-based charts (`react-native-svg`).
- **Nutrition Logging**: Rapid meal entry and barcode scanning.

## Project Structure

- `app/`: Expo Router screens (file-based routing).
- `components/`: React Native UI components (SVG-based charts).
- `modules/`: Native Swift modules:
  - `background-refresh`: iOS background task registration.
  - `ble-probe`: Generic BLE explorer for reverse engineering.
  - `whoop-ble`: Specialized WHOOP IMU streaming.
  - `health-kit`: Apple Health integration.
  - `core-motion`: iOS motion data access.
- `lib/`: Shared logic, tRPC client, and background sync workers.
- `targets/`: Native watchOS extension (DofekWatch).

## Development

```bash
cd packages/mobile
pnpm dev
```

## Testing

- **Component tests**: `pnpm test` (Vitest)
- **Native modules**: Swift tests in `modules/<name>/Tests/` (XCTest)
