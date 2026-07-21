# dofek-mobile

The mobile app for Dofek. Built with Expo and React Native, with native Swift modules for HealthKit and WHOOP BLE synchronization.

## Core Features

- **HealthKit Sync**: Background synchronization of health and fitness metrics from iOS using `BackgroundRefreshModule` which registers `BGAppRefreshTask`.
- **WHOOP BLE Sync**: High-resolution sensor data capture (IMU - accelerometer + gyroscope) from WHOOP straps via `WhoopBleModule`.
- **Bluetooth Heart-Rate Monitors**: Live heart rate + R-R intervals from any standard Bluetooth heart-rate strap via `BleHeartRateModule`, using the Bluetooth SIG [Heart Rate Service](https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/) (`0x180D`) / Heart Rate Measurement (`0x2A37`) GATT profile. See `../../docs/ble-heart-rate.md`.
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
  - `ble-heart-rate`: Standard Bluetooth heart-rate monitor (GATT Heart Rate Service).
  - `health-kit`: Apple Health integration.
  - `core-motion`: iOS motion data access.
- `lib/`: Shared logic, tRPC client, and background sync workers.
- `targets/`: Native watchOS extension (DofekWatch).

## Development

```bash
cd packages/mobile
pnpm start
```

### iOS Simulator development build

This app contains custom Swift modules, so use the checked-in Xcode workspace
and a development client rather than relying on Expo Go. Expo documents both
the local iOS Simulator setup and the development-build workflow:
<https://docs.expo.dev/workflow/ios-simulator/> and
<https://docs.expo.dev/build-reference/simulators/>.

1. Boot a simulator and build the `Dofek` scheme from
   `ios/Dofek.xcworkspace` for `iphonesimulator`. The repository's
   XcodeBuildMCP configuration can perform the build, install, launch, log, and
   screenshot operations; Xcode or `xcodebuild` can do the same locally.
2. Load the required `EXPO_PUBLIC_*` runtime values from Infisical before the
   build. In particular, `EXPO_PUBLIC_SENTRY_DSN` must be a valid DSN.
3. Start Metro for the development client:

   ```bash
   pnpm expo start --dev-client --localhost \
     --private-key-path /secure/path/to/private-key.pem
   ```

4. Install and launch the built `.app`, then verify that a real application
   screen renders before beginning UI exploration. A running process that is
   still showing the Expo development launcher is not an app-level validation.

The native binary embeds `certs/certificate.pem`, so Metro must sign the
development manifest with the corresponding private key. The private key is
intentionally ignored by Git and must come from approved secret storage; never
copy it into the repository or logs. Expo's code-signing guide explains why the
certificate is committed while the private key remains secret:
<https://docs.expo.dev/eas-update/code-signing/>.

The iOS Simulator cannot exercise Bluetooth, accelerometer, gyroscope, or other
device-only hardware. Use it for navigation, rendering, API/error states, and
software-only flows; use physical devices for BLE and motion validation. Expo
lists current simulator hardware limitations here:
<https://docs.expo.dev/workflow/ios-simulator/#limitations>.

### Signed Release simulator audit

Use an embedded Release bundle when the goal is to audit production-like app UI
without Metro. The command below uses local ad-hoc signing so keychain-backed
SecureStore remains available without a distribution identity:

```bash
EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:3100 \
EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id \
SENTRY_DISABLE_AUTO_UPLOAD=true \
xcodebuild -quiet \
  -workspace ios/Dofek.xcworkspace \
  -scheme Dofek \
  -configuration Release \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  -derivedDataPath .context/ReleaseAuditDerivedData \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= \
  PROVISIONING_PROFILE_SPECIFIER= \
  build
```

Do not add a global `-sdk iphonesimulator`: the checked-in `Dofek` scheme also
contains the watchOS app, and the destination is sufficient to select the iOS
Simulator for the main target. Do not use `CODE_SIGNING_ALLOWED=NO`, because an
unsigned audit artifact lacks the keychain entitlements SecureStore needs. Do
not override `INFOPLIST_FILE` globally; doing so drops the main target's declared
background modes. These constraints come from the checked-in
[`Dofek.xcscheme`](ios/Dofek.xcodeproj/xcshareddata/xcschemes/Dofek.xcscheme),
[`project.pbxproj`](ios/Dofek.xcodeproj/project.pbxproj), and
[`Info.plist`](ios/Dofek/Info.plist).

Install and launch the resulting
`.context/ReleaseAuditDerivedData/Build/Products/Release-iphonesimulator/Dofek.app`,
then verify visible UI, native accessibility targets, app logs, and server logs.
Expo's local production-build guide is the upstream reference for using
Release configuration locally:
<https://docs.expo.dev/guides/local-app-production/>.

## Dependency pins

- `@react-native-async-storage/async-storage@2.2.0` — stay on 2.2.x for Expo SDK 57. AsyncStorage 3.x breaks iOS builds on recent Expo SDKs; see [expo/expo#43757](https://github.com/expo/expo/issues/43757).

## Testing

- **Component tests**: `pnpm test:mobile` from the repo root (Vitest mobile project)
- **Native modules**: Swift tests in `modules/<name>/Tests/` (XCTest)

## Mobile Telemetry

`lib/telemetry.ts` always reports exceptions to Sentry via `EXPO_PUBLIC_SENTRY_DSN`.

To export mobile OpenTelemetry logs to Axiom, set this public env var in Infisical (`prod`):

- `EXPO_PUBLIC_OTEL_ENDPOINT` (for example, `https://api.axiom.co/v1/logs`)

If the collector requires headers, set `EXPO_PUBLIC_OTEL_HEADERS` (for example, `Authorization=Bearer <token>,x-axiom-dataset=<dataset>`). Expo embeds `EXPO_PUBLIC_*` values in the client bundle, so only use write-only ingest credentials here (https://docs.expo.dev/guides/environment-variables/#reading-environment-variables-from-env-files).

Mobile workflows load secrets from Infisical via GitHub OIDC ([`load-infisical-secrets`](../../.github/actions/load-infisical-secrets/action.yml)). Runtime env vars loaded into the app bundle:

- `EXPO_PUBLIC_SENTRY_DSN`
- `EXPO_PUBLIC_OTEL_ENDPOINT`
- `EXPO_PUBLIC_OTEL_HEADERS` (optional)

Workflow-only secrets loaded by iOS and OTA workflows ([iOS](../../.github/workflows/deploy-ios.yml), [OTA](../../.github/workflows/deploy-ota.yml)):

- `SENTRY_AUTH_TOKEN` (iOS and OTA sourcemap uploads)
- `EXPO_TOKEN` (OTA workflows)

The shared Infisical action fails when a requested secret is missing, so keep this list aligned with each workflow's `keys` block ([source](../../.github/actions/load-infisical-secrets/action.yml)).

Use a dedicated write-only ingest token for mobile OTEL headers if the collector needs authentication. Do not reuse broad admin/read tokens.

Workflow key requirements:

- `.github/workflows/build-mobile.yml`: `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
- `.github/workflows/deploy-ios.yml`: `SENTRY_AUTH_TOKEN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
- `.github/workflows/deploy-ota.yml`: `EXPO_TOKEN`, `SENTRY_AUTH_TOKEN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
- `.github/workflows/mobile-preview-ota.yml`: `EXPO_TOKEN`, `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_OTEL_ENDPOINT`, `EXPO_PUBLIC_OTEL_HEADERS`
