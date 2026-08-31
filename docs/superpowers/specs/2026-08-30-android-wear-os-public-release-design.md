# Android and Wear OS Public Release Design

## Goal

Ship Dofek as a public Google Play application with functional Android phone
and Wear OS 3+ counterparts, and automatically publish a signed production
release from every green `main` commit.

## Current state

`packages/mobile` is an Expo/React Native phone application configured only for
iOS. Its `DofekWatch` watchOS target records motion and relative-altitude data,
durably transfers compressed files to the paired phone, and lets the phone
ingest the resulting canonical payloads. The Google Play Organization account
is **Sender Software**; no Android app record exists yet.

## Scope

### Android phone

- Retain the existing Expo/React Native phone UI and shared TypeScript domain
  logic. Add Android-native implementations only where a feature needs a
  platform API.
- Use `com.dofek.app` as the Android application ID and target Android 16
  (API 36), which Google Play requires for new submissions after August 31,
  2026. [Google Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk)
- Replace the Apple Health connection with Health Connect. Request only the
  health data types that power a current, user-visible Dofek feature; check
  permission state before every use; expose a user-facing connection toggle and
  a route to manage access. [Health Connect setup](https://developer.android.com/health-and-fitness/health-connect/get-started)
  [Health Connect permission UX](https://developer.android.com/health-and-fitness/health-connect/ui/permissions)
- Implement Android equivalents for Bluetooth heart-rate monitoring, activity
  GPS recording, barcode scanning, notifications, native telemetry, and secure
  credential storage. Apple-only HealthKit and Apple Watch behavior must not be
  presented as available on Android.

### Wear OS companion

- Add a Kotlin/Compose Wear OS 3+ companion to the Android Gradle build. It
  mirrors the existing watchOS target's recording state, sensor availability,
  pending file count, companion reachability, manual recording, and manual
  sync controls.
- Use Wear OS Health Services instead of direct sensor management where it
  serves the required workout or passive-monitoring capability. Use restricted
  background body-sensor access only when it is essential to an approved,
  disclosed feature. [Wear OS Health Services](https://developer.android.com/health-and-fitness/health-services)
  [background body-sensor access](https://developer.android.com/health-and-fitness/health-services/background-body-sensors)
- Persist recordings locally before transfer. Send compressed typed sensor files
  to the paired phone through the Wearable Data Layer. The Android phone owns
  session credentials and validates, queues, and uploads the received payloads;
  the watch never receives a long-lived server credential.
- Keep Android/Wear source durable and reproducible through Expo prebuild:
  native project integration belongs in a config plugin and source-controlled
  modules/targets, never in generated `android/` output alone.

## Release architecture

- Pull requests run TypeScript lint/type checks/tests, Android native unit
  tests, phone and Wear OS builds, and emulator smoke tests for the supported
  paths.
- A successful `main` commit produces a monotonically versioned, signed Android
  App Bundle (AAB), then creates a Google Play **Production** release through
  the Google Play Developer API. The pipeline reports any Play review or policy
  rejection as a failed deployment; it never changes tracks or suppresses the
  error.
- Enroll the app in Play App Signing. Google retains the app-signing key and CI
  holds only a separate upload key. [Android app signing](https://developer.android.com/studio/publish/app-signing)
- Store the Play Developer API service-account credential, upload-key material,
  and passwords in Infisical/GitHub Actions secrets. No key material is
  committed, printed, or embedded in the app.
- Build number generation is CI-owned and strictly increasing. Production
  publication is tied to the exact checked-out `main` SHA and its successful CI
  run, as in the existing iOS deployment workflow.

## Google Play setup and compliance

- Create the Dofek Android app record in the Sender Software account, enroll
  Play App Signing, and grant the CI service account only the release permissions
  it needs.
- Complete the Play store listing, content rating, app-access instructions,
  country availability, privacy-policy URL, Data Safety declaration, and Health
  Apps declaration before the first production deployment. Health Connect
  declarations must name and justify each requested type and use the same
  privacy policy displayed in the app. [Publishing a Health Connect app](https://developer.android.com/health-and-fitness/health-connect/publish)
- Google Play review remains an external gate. Continuous deployment submits the
  approved AAB and release configuration; it cannot bypass Google review,
  account verification, or policy decisions.

## Error handling and observability

- Native Android and Wear OS failures are captured in Sentry with platform,
  app-version, and release identifiers. The phone surfaces actionable native
  setup and permission errors rather than generic failures.
- CI fails explicitly when a required secret, signing prerequisite, Play API
  permission, policy declaration, or upload response is missing or rejected.

## Validation

- Test pure Kotlin transfer, buffering, versioning, and release-config behavior
  first; execute native integration tests on Android emulators and physical
  Android/Wear devices for sensor, Health Connect, BLE, location, background,
  and phone-watch transfer behavior.
- Before first public deployment, validate the actual signed AAB on the release
  devices and verify the full Google Play upload path using the Production
  release configuration.

## Non-goals

- No second Android-only product, no server-side duplication, and no long-lived
  authentication token on the watch.
- No automatic workaround or track downgrade when Play rejects a release.
- No attempt to claim hardware features are equivalent when a target device
  lacks the sensor or OS capability; the UI reports that state directly.
