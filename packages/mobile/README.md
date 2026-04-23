# dofek-mobile

The mobile app for Dofek. Built with Expo and React Native, with native Swift modules for HealthKit and WHOOP BLE synchronization.

## Core Features

- **HealthKit Sync**: Background synchronization of health and fitness metrics from iOS using `BackgroundRefreshModule` which registers `BGAppRefreshTask`.
- **WHOOP BLE Sync**: High-resolution sensor data capture (IMU - accelerometer + gyroscope) from WHOOP straps via `WhoopBleModule`.
- **Activity Recording**: Real-time GPS and sensor recording for workouts, utilizing native `CoreMotion` and `WatchMotion` modules.
- **Mobile Dashboard**: Simplified mobile-first health and recovery tracking with SVG-based charts (`react-native-svg`).
- **Nutrition Logging**: Rapid meal entry, barcode scanning, and natural-language AI meal input that splits a single message into multiple food items.

See `../../docs/nutrition-ai-input.md` for end-to-end behavior and API flow.

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

## Mobile Telemetry

`lib/telemetry.ts` always reports exceptions to Sentry via `EXPO_PUBLIC_SENTRY_DSN`.

To export mobile OpenTelemetry logs to Axiom, set both of these public env vars in Infisical (`prod`):

- `EXPO_PUBLIC_OTEL_ENDPOINT` (for example, `https://api.axiom.co/v1/logs`)
- `EXPO_PUBLIC_OTEL_HEADERS` (for example, `Authorization=Bearer <token>,x-axiom-dataset=<dataset>`)

Mobile workflows load all runtime env values from Infisical via GitHub OIDC (`.github/actions/load-infisical-secrets`), including:

- `EXPO_PUBLIC_SENTRY_DSN`
- `EXPO_PUBLIC_OTEL_ENDPOINT`
- `EXPO_PUBLIC_OTEL_HEADERS`
- `EXPO_TOKEN` (OTA workflows)

Use a dedicated write-only ingest token for mobile OTEL headers (do not reuse broad admin/read tokens).

Workflows that must include these vars:

- `.github/workflows/build-mobile.yml`
- `.github/workflows/deploy-ota.yml`
- `.github/workflows/mobile-preview-ota.yml`
