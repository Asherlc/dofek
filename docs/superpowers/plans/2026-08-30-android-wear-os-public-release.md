# Android and Wear OS Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public-production Android phone and Wear OS release path that preserves Dofek's native health and watch data contracts.

**Architecture:** Expo continues to own the shared React Native phone application and prebuild configuration. Android-specific Expo modules own Health Connect and phone-watch ingestion; a Kotlin/Compose Wear OS module records durable files and delivers them through the Wearable Data Layer. GitHub Actions builds a signed AAB and releases the exact green `main` SHA through the Google Play Developer API.

**Tech Stack:** Expo SDK 57, React Native 0.86, Kotlin, Jetpack Compose for Wear OS, Health Connect, Wear OS Health Services, Wearable Data Layer, Gradle, GitHub Actions, Infisical, Google Play Developer API, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-android-wear-os-public-release-design.md`

## Global Constraints

- Android targets API 36 and uses `com.dofek.app`.
- Source-controlled config plugins/modules, not generated `android/`, own durable native behavior.
- The watch persists recordings before phone transfer and never receives a long-lived server credential.
- Health Connect permissions must match current user-visible features and the Play Health Apps/Data Safety declarations.
- Every new behavior is developed test-first; native runtime failures are captured in Sentry and surfaced with actionable messages.
- Green `main` deploys only to the Google Play Production track and fails explicitly on every missing prerequisite or rejected Play response.

---

### Task 1: Android app configuration

**Files:**
- Modify: `packages/mobile/app.json`
- Modify: `packages/mobile/package.json`
- Modify: `packages/mobile/README.md`

**Interfaces:**
- Produces Expo Android configuration with `android.package === "com.dofek.app"` and API 36 build properties.
- Produces `pnpm android` and `pnpm prebuild:android` scripts for CI and local validation.

- [ ] **Step 1: Add the minimum Android Expo configuration**

```json
"android": {
  "package": "com.dofek.app",
  "versionCode": 1
}
```

Add the `expo-build-properties` Android object with `compileSdkVersion` and
`targetSdkVersion` set to `36`, then add the Android scripts without changing
the existing iOS prebuild command.

- [ ] **Step 2: Verify generated configuration and a real Android prebuild**

Run: `cd packages/mobile && pnpm expo config --type public && pnpm expo prebuild --platform android --clean --no-install`

Expected: emitted config has package `com.dofek.app` and target API 36; prebuild succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/app.json packages/mobile/package.json packages/mobile/README.md
git commit -m "feat(mobile): configure Android application"
```

### Task 2: Platform-native gateway

**Files:**
- Create: `packages/mobile/lib/platform-native/types.ts`
- Create: `packages/mobile/lib/platform-native/health.ios.ts`
- Create: `packages/mobile/lib/platform-native/health.android.ts`
- Create: `packages/mobile/lib/platform-native/watch.ios.ts`
- Create: `packages/mobile/lib/platform-native/watch.android.ts`
- Create: `packages/mobile/lib/platform-native/health.test.ts`
- Create: `packages/mobile/lib/platform-native/watch.test.ts`
- Modify: `packages/mobile/lib/apple-health-provider.ts`
- Modify: `packages/mobile/lib/background-health-kit-sync.ts`
- Modify: `packages/mobile/lib/health-kit-sync.ts`
- Modify: `packages/mobile/lib/useAutoSync.ts`
- Modify: `packages/mobile/lib/watch-file-sync.ts`
- Modify: `packages/mobile/lib/watch-altitude-file-sync.ts`
- Modify: `packages/mobile/lib/background-watch-inertial-measurement-unit-sync.ts`
- Modify: `packages/mobile/lib/mobile-account-purge.ts`
- Modify: `packages/mobile/app/_layout.tsx`
- Modify: `packages/mobile/app/record.tsx`
- Modify: `packages/mobile/app/providers/index.tsx`

**Interfaces:**
- Produces a single platform-resolved health gateway and watch gateway. The
  iOS files adapt the current `health-kit` and `watch-motion` module contracts;
  Android files adapt the later Health Connect and Wear OS modules.
- No shared application file imports `modules/health-kit` or
  `modules/watch-motion` directly. Metro selects `.ios.ts` or `.android.ts`
  before an iOS-only native module can be evaluated on Android.

- [ ] **Step 1: Write failing gateway tests**

```ts
expect(healthGateway.kind).toBe("health-kit");
expect(watchGateway.kind).toBe("watch-os");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/mobile/lib/platform-native/health.test.ts packages/mobile/lib/platform-native/watch.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement platform-resolved gateways and migrate every direct import**

```ts
export interface HealthGateway {
  readonly kind: "health-kit" | "health-connect";
  getRequestStatus(): Promise<HealthRequestStatus>;
  requestPermissions(): Promise<boolean>;
  purgeAccountState(cutoff: string): Promise<boolean>;
}
```

Each exported gateway method is a production feature contract, not a test-only
optional branch. The Android implementation must reject with a specific
unsupported or permission-required message until its corresponding Android
module is added in Task 3. Replace every listed direct import in one change and
leave no Apple-native import reachable from shared application startup.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run packages/mobile/lib/platform-native/health.test.ts packages/mobile/lib/platform-native/watch.test.ts packages/mobile/lib/mobile-account-purge.test.ts && cd packages/mobile && pnpm expo export --platform android --clear`

Expected: PASS; Android Metro export evaluates no iOS native module.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/lib/platform-native packages/mobile/lib packages/mobile/app
git commit -m "refactor(mobile): isolate platform native gateways"
```

### Task 3: Health Connect module and permission UX

**Files:**
- Create: `packages/mobile/modules/health-connect/expo-module.config.json`
- Create: `packages/mobile/modules/health-connect/src/HealthConnectModule.ts`
- Create: `packages/mobile/modules/health-connect/index.ts`
- Create: `packages/mobile/modules/health-connect/index.test.ts`
- Create: `packages/mobile/modules/health-connect/android/src/main/java/com/dofek/healthconnect/HealthConnectModule.kt`
- Create: `packages/mobile/modules/health-connect/android/src/main/AndroidManifest.xml`
- Modify: `packages/mobile/app/(tabs)/settings.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/settings.test.tsx`

**Interfaces:**
- Produces `HealthConnectClient.getStatus(): Promise<"available" | "unavailable" | "permission-required">`, `requestPermissions()`, and `openManageAccess()`.
- The Android module maps runtime Health Connect availability and permissions to those values; the Settings UI renders the module's actionable error message.

- [ ] **Step 1: Write failing TypeScript and Settings tests**

```ts
await expect(healthConnect.getStatus()).resolves.toBe("permission-required");
expect(screen.getByRole("button", { name: "Connect Health Connect" })).toBeTruthy();
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/mobile/modules/health-connect/index.test.ts packages/mobile/app-tests/(tabs)/settings.test.tsx`

Expected: FAIL because the module and Settings action do not exist.

- [ ] **Step 3: Implement the Expo/Kotlin module and UI**

The Kotlin implementation must use `HealthConnectClient.getSdkStatus`, inspect
granted permissions before every read/write operation, request only the
specific record types exposed by Dofek, and expose the Android Health Connect
manage-access intent. The manifest includes only corresponding health
permissions and the permission-rationale activity.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run packages/mobile/modules/health-connect/index.test.ts packages/mobile/app-tests/(tabs)/settings.test.tsx && cd packages/mobile && pnpm expo prebuild --platform android --clean --no-install`

Expected: PASS; generated Android manifest contains only declared Health Connect permissions.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/modules/health-connect packages/mobile/app/(tabs)/settings.tsx packages/mobile/app-tests/(tabs)/settings.test.tsx packages/mobile/app.json
git commit -m "feat(mobile): add Health Connect integration"
```

### Task 4: Android native equivalents for active capture

**Files:**
- Create: `packages/mobile/modules/background-refresh/android/src/main/java/com/dofek/backgroundrefresh/BackgroundRefreshModule.kt`
- Create: `packages/mobile/modules/ble-heart-rate/android/src/main/java/com/dofek/bleheartrate/BleHeartRateModule.kt`
- Create: `packages/mobile/modules/core-motion/android/src/main/java/com/dofek/coremotion/CoreMotionModule.kt`
- Modify: each matching `expo-module.config.json`
- Modify: each module’s colocated TypeScript test

**Interfaces:**
- Every existing TypeScript native-module API has an Android implementation or a platform-specific, actionable unsupported-feature result.
- Background jobs, Bluetooth, activity motion, location, and camera permissions are declared only for their active app features.

- [ ] **Step 1: Add a failing availability contract to each module test**

```ts
expect(await nativeModule.getAvailability()).toEqual({ available: true });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test:mobile -- packages/mobile/modules/background-refresh packages/mobile/modules/ble-heart-rate packages/mobile/modules/core-motion`

Expected: FAIL because Android native implementations are absent.

- [ ] **Step 3: Implement the Kotlin modules and minimal Android permissions**

Use WorkManager for durable periodic scheduling, Android Bluetooth LE APIs for
the Heart Rate Service, and Android sensor/location APIs for active recording.
Route unexpected native exceptions through the existing mobile telemetry bridge
and reject with a message identifying the missing permission or hardware.

- [ ] **Step 4: Verify GREEN on an Android emulator and unit tier**

Run: `pnpm test:mobile -- packages/mobile/modules/background-refresh packages/mobile/modules/ble-heart-rate packages/mobile/modules/core-motion && cd packages/mobile && pnpm expo run:android --variant debug`

Expected: unit tests pass; the app launches and displays permission-specific UI.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/modules/background-refresh packages/mobile/modules/ble-heart-rate packages/mobile/modules/core-motion packages/mobile/app.json
git commit -m "feat(mobile): add Android capture modules"
```

### Task 5: Durable Wear OS recorder and phone receiver

**Files:**
- Create: `packages/mobile/targets/DofekWear/settings.gradle.kts`
- Create: `packages/mobile/targets/DofekWear/build.gradle.kts`
- Create: `packages/mobile/targets/DofekWear/app/build.gradle.kts`
- Create: `packages/mobile/targets/DofekWear/app/src/main/java/com/dofek/wear/RecordingRepository.kt`
- Create: `packages/mobile/targets/DofekWear/app/src/main/java/com/dofek/wear/WearTransferClient.kt`
- Create: `packages/mobile/targets/DofekWear/app/src/main/java/com/dofek/wear/MainActivity.kt`
- Create: `packages/mobile/targets/DofekWear/app/src/test/java/com/dofek/wear/RecordingRepositoryTest.kt`
- Create: `packages/mobile/modules/wear-motion/android/src/main/java/com/dofek/wearmotion/WearMotionModule.kt`
- Create: `packages/mobile/modules/wear-motion/index.ts`
- Create: `packages/mobile/modules/wear-motion/index.test.ts`
- Create: `packages/mobile/plugins/with-wear-os-target.js`

**Interfaces:**
- `RecordingRepository.append(sample)` persists samples before `WearTransferClient.enqueue(payload)` can send them.
- `WearMotionModule.listPendingFiles()`, `readFile(name)`, and `deleteFile(name)` use the same JSON schemas as `watch-motion`.
- The config plugin includes `:DofekWear` in generated Android Gradle settings without modifying generated output by hand.

- [ ] **Step 1: Write failing Kotlin and TypeScript transfer tests**

```kotlin
assertThat(repository.pendingFiles()).containsExactly("wear-motion-1.json.gz")
```

```ts
await expect(readWearFile("../escape.json")).rejects.toThrow("Invalid pending watch file name");
```

- [ ] **Step 2: Verify RED**

Run: `cd packages/mobile/targets/DofekWear && ./gradlew test && pnpm vitest run ../../modules/wear-motion/index.test.ts`

Expected: FAIL because the target, receiver, and module do not exist.

- [ ] **Step 3: Implement durable recording and transfer**

Use Room for the pending-file receipt state and Health Services for supported
workout/passive sensor recording. Serialize the canonical IMU and altitude
schemas, gzip the file, and use the Wearable Data Layer channel/file API to
deliver it. The Android receiver atomically moves completed files to an
account-scoped inbox and rejects unsafe names exactly as the existing iOS
receiver does.

- [ ] **Step 4: Verify GREEN**

Run: `cd packages/mobile/targets/DofekWear && ./gradlew test && pnpm vitest run packages/mobile/modules/wear-motion/index.test.ts && cd packages/mobile && pnpm expo prebuild --platform android --clean --no-install`

Expected: all tests pass; generated Gradle settings include `DofekWear`.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/targets/DofekWear packages/mobile/modules/wear-motion packages/mobile/plugins/with-wear-os-target.js packages/mobile/app.json
git commit -m "feat(mobile): add Wear OS recorder"
```

### Task 6: Android/Wear build verification in CI

**Files:**
- Modify: `.github/workflows/build-mobile.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/mobile/README.md`

**Interfaces:**
- Pull requests that change mobile inputs run Android Expo export/prebuild,
  Android phone AAB compilation, Wear OS Gradle tests/build, and emulator smoke
  validation.

- [ ] **Step 1: Add Android CI jobs**

Use a current Ubuntu runner with JDK 21 and Android API 36. Export and prebuild
Android, run the Wear target’s Gradle unit tests, build the phone AAB and Wear
APK/AAB without production signing, and run a bounded emulator launch smoke
test. Retain build logs as artifacts on failure.

- [ ] **Step 2: Verify workflow syntax and download policy**

Run: `pnpm lint:workflow-downloads && pnpm lint`

Expected: workflow downloads remain pinned and the repository workflow/static
configuration checks pass. The CI run itself is the executable build validation.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-mobile.yml .github/workflows/ci.yml packages/mobile/README.md
git commit -m "ci: verify Android and Wear OS builds"
```

### Task 7: Google Play production deployment

**Files:**
- Create: `.github/workflows/deploy-android.yml`
- Create: `scripts/validate-google-play-release.ts`
- Create: `scripts/validate-google-play-release.test.ts`
- Modify: `.github/workflows/deploy.yml`
- Modify: `deploy/README.md`

**Interfaces:**
- `validateGooglePlayRelease(environment): { serviceAccountJson: string; uploadKeyStore: string; uploadKeyAlias: string; uploadKeyPassword: string; keyStorePassword: string }` throws an error naming every missing required key.
- `deploy-android.yml` runs only after successful CI for `main`, builds the resolved SHA, signs it with the upload key, uploads the AAB through the Google Play Developer API, and commits a Production release.

- [ ] **Step 1: Write failing secret-validation tests**

```ts
expect(() => validateGooglePlayRelease({})).toThrow(
  "Missing required Google Play secret: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run scripts/validate-google-play-release.test.ts`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement validation and production workflow**

Load exactly these Infisical keys: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`,
`ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEY_ALIAS`,
`ANDROID_UPLOAD_KEYSTORE_PASSWORD`, and `ANDROID_UPLOAD_KEY_PASSWORD`.
Validate them before Gradle runs. Build the exact resolved SHA, derive a strictly
increasing `versionCode` from the GitHub run ID, sign the AAB with the upload
key, and upload through a pinned, current Google Play API client. Set only the
`production` track and fail on a non-successful API response.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run scripts/validate-google-play-release.test.ts && pnpm lint:workflow-downloads && pnpm lint`

Expected: PASS; absent secrets fail with exact names and no release command can
select a non-production track.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-android.yml .github/workflows/deploy.yml scripts/validate-google-play-release.ts scripts/validate-google-play-release.test.ts deploy/README.md
git commit -m "ci: deploy Android production releases"
```

### Task 8: Play Console app record and first public release

**Files:**
- Modify: `packages/mobile/app-store/README.md`
- Modify: `deploy/README.md`

**Interfaces:**
- Produces a Play Console Dofek app record with Play App Signing, Android store
  listing, privacy policy URL, Data Safety declaration, Health Apps declaration,
  production availability, and least-privilege CI service account.

- [ ] **Step 1: Prepare the current feature-to-permission declaration table**

```md
| Health Connect type | User-visible feature | In-app explanation | Play declaration rationale |
|---|---|---|---|
| Heart rate | Recovery and trend cards | Show heart-rate history | Render user-authorized recovery history |
```

- [ ] **Step 2: Validate that every declared permission has a current app feature**

Run: `pnpm lint && pnpm test:mobile`

Expected: PASS; no declaration claims a removed or unimplemented capability.

- [ ] **Step 3: Create and configure the app record in Play Console**

Create `Dofek` under Sender Software, package `com.dofek.app`, enroll Play App
Signing, upload the service account, publish the listing and declarations, and
create the Production release with the CI-built AAB. Confirm each final
submission action immediately before it is sent because it changes a public
store listing or public rollout.

- [ ] **Step 4: Validate public release evidence**

Run: `gh run watch <deploy-android-run-id> --exit-status`

Expected: the job summary links the release, exact SHA, version, versionCode,
and Play Production response; Play Console shows no unresolved declaration or
release error.

- [ ] **Step 5: Commit documentation**

```bash
git add packages/mobile/app-store/README.md deploy/README.md
git commit -m "docs: record Android Play release operations"
```
