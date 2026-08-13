# Remove iOS Manual Activity Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Dofek's manual iOS GPS workout recorder and its private server persistence API without changing provider-imported activity history or passive iPhone/watchOS collection.

**Architecture:** Activities remains a history, route-display, and deletion screen, but has no recorder entry point. Delete the manual recorder's client/server vertical slice, then remove its unused Expo location dependencies and native permissions. Passive accelerometer, WatchConnectivity, WHOOP, and BLE paths remain unchanged because they start from independent background services.

**Tech Stack:** Expo Router, React Native, TypeScript, tRPC, Vitest, pnpm, Expo app configuration.

## Global Constraints

- Preserve Apple Health/provider activity and route imports, activity display, and activity deletion.
- Preserve background iPhone/watchOS motion collection, WatchConnectivity, WHOOP BLE, and BLE heart-rate support.
- Do not add absence tests for deleted routes, APIs, files, or configuration; delete tests dedicated to the retired behavior.
- Keep `packages/mobile/app/` route-only and do not add compatibility routes, endpoints, flags, or fallbacks.
- Prefix shell commands with `rtk`; use `pnpm` for repository tooling.
- Commit each independently reviewable task and push to `origin/remove-activity-recording-ios-dofek`.

---

## File Structure

| File | Responsibility after this change |
|---|---|
| `packages/mobile/app/(tabs)/activities.tsx` | Display, filter, select, and delete imported activities only. |
| `packages/mobile/app.json` | Declare only iOS capabilities used by surviving mobile features. |
| `packages/mobile/package.json` / `pnpm-lock.yaml` | Retain only active mobile dependencies. |
| `packages/mobile/README.md` | Describe imported activity history and passive synchronization. |
| `packages/server/src/router.ts` | Register only active tRPC routers. |
| `packages/server/src/router.test.ts` | Validate active server router composition. |

### Task 1: Remove the manual-recording persistence API

**Files:**
- Delete: `packages/server/src/routers/activity-recording.ts`
- Delete: `packages/server/src/routers/activity-recording.test.ts`
- Delete: `packages/server/src/repositories/activity-recording-repository.ts`
- Delete: `packages/server/src/repositories/activity-recording-repository.test.ts`
- Modify: `packages/server/src/router.ts:4,81`
- Modify: `packages/server/src/router.test.ts:15,128`

**Interfaces:**
- Consumes: no new interfaces; `activityRecording.save` has no consumer after the mobile recorder is removed.
- Produces: the root tRPC router exposes no `activityRecording` member; active `activity` APIs do not change.

- [x] **Step 1: Confirm the implementation is self-contained**

Run:

```bash
rtk rg -n "ActivityRecordingRepository|activityRecordingRouter|activityRecording" \
  packages/server packages/mobile src --glob '!**/*.test.ts'
```

Expected: only the recorder client, dedicated router/repository, and root-router registration appear. Do not add an absence test.

- [x] **Step 2: Delete the dedicated API and its focused tests**

Delete all four API files. Remove exactly this import and root-router property
from `packages/server/src/router.ts`:

```ts
import { activityRecordingRouter } from "./routers/activity-recording.ts";
activityRecording: activityRecordingRouter,
```

In `packages/server/src/router.test.ts`, delete the matching `vi.mock` and the
`"activityRecording"` expected router key. The retained test exercises the
active router composition rather than proving a removed interface is absent.

- [x] **Step 3: Run the active root-router regression**

Run:

```bash
rtk pnpm exec vitest run packages/server/src/router.test.ts
```

Expected: PASS.

- [x] **Step 4: Audit API references**

Run the Step 1 search again. Expected: no output in production source.

- [x] **Step 5: Commit and push**

```bash
rtk git add packages/server/src/router.ts packages/server/src/router.test.ts \
  packages/server/src/routers/activity-recording.ts \
  packages/server/src/routers/activity-recording.test.ts \
  packages/server/src/repositories/activity-recording-repository.ts \
  packages/server/src/repositories/activity-recording-repository.test.ts
rtk git commit -m "feat: remove manual activity recording API"
rtk git push
```

### Task 2: Remove the mobile recorder route and its private services

**Files:**
- Delete: `packages/mobile/app/record.tsx`
- Delete: `packages/mobile/lib/activity-recording.ts`
- Delete: `packages/mobile/lib/activity-recording.test.ts`
- Delete: `packages/mobile/lib/location-service.ts`
- Delete: `packages/mobile/lib/location-service.test.ts`
- Delete: `packages/mobile/lib/recording-sensor-service.ts`
- Delete: `packages/mobile/lib/recording-sensor-service.test.ts`
- Delete: `packages/mobile/lib/heart-rate-recording-service.ts`
- Delete: `packages/mobile/lib/heart-rate-recording-service.test.ts`
- Delete: `packages/mobile/lib/inertial-measurement-unit-service.ts`
- Delete: `packages/mobile/lib/inertial-measurement-unit-service.test.ts`
- Modify: `packages/mobile/app/(tabs)/activities.tsx:22,159,293-302,777-786`
- Modify: `packages/mobile/lib/background-whoop-ble-sync.ts`
- Modify: `packages/mobile/lib/background-whoop-ble-sync.test.ts`
- Modify: `packages/mobile/lib/useWhoopBleSync.ts`
- Modify: `packages/mobile/lib/useWhoopBleSync.test.ts`

**Interfaces:**
- Consumes: unchanged `trpc.calendar.*` and `trpc.activity.*` imported-activity queries/mutations.
- Produces: Activities remains the activity-history UI, but no longer navigates to `/record` or starts manual collection.

- [x] **Step 1: Confirm passive sensor paths are independent**

Run:

```bash
rtk rg -n "createInertialMeasurementUnitService|createHeartRateRecordingService|combineRecordingSensorServices|createLocationAdapter|createActivityRecorder" packages/mobile
```

Expected: callers are the manual route/files listed above. The retained passive
WHOOP sync imports `InertialMeasurementUnitUploadClient` from the deleted
recorder-owned service, so move that interface to `background-whoop-ble-sync.ts`
and update its hook/tests to import it there. This approved dependency-boundary
correction changes no passive runtime behavior. Do not modify
`background-accelerometer-sync.ts`,
`background-watch-inertial-measurement-unit-sync.ts`, watch-motion, health-kit,
or any watchOS target file.

- [x] **Step 2: Remove the Activities entry point**

Remove the `TouchableOpacity` that pushes `/record` and the `recordButton` /
`recordButtonText` styles from `packages/mobile/app/(tabs)/activities.tsx`.
Retain `useRouter` because it still powers required activity-detail navigation.
Retain refresh, filters, selection, deletion, imported-route display, and all
other UI.

- [x] **Step 3: Delete the manual route and dedicated services**

Delete the five source/test file pairs listed in **Files**. Do not retain no-op
exports or hidden route implementations.

- [x] **Step 4: Run active mobile regressions**

Run:

```bash
rtk pnpm exec vitest run --project mobile packages/mobile/app-tests
rtk pnpm test:mobile
```

Expected: PASS. Existing activity tests demonstrate imported data still renders;
do not add an absence test for the retired recorder.

- [x] **Step 5: Audit stale recorder references**

Run:

```bash
rtk rg -n -i "activity-recording|Record Activity|createActivityRecorder|createLocationAdapter|createHeartRateRecordingService|createInertialMeasurementUnitService|combineRecordingSensorServices" packages/mobile
```

Expected: no output in source and tests.

- [x] **Step 6: Commit and push**

```bash
rtk git add packages/mobile/app/'(tabs)'/activities.tsx packages/mobile/app/record.tsx \
  packages/mobile/lib/activity-recording.ts packages/mobile/lib/activity-recording.test.ts \
  packages/mobile/lib/location-service.ts packages/mobile/lib/location-service.test.ts \
  packages/mobile/lib/recording-sensor-service.ts packages/mobile/lib/recording-sensor-service.test.ts \
  packages/mobile/lib/heart-rate-recording-service.ts packages/mobile/lib/heart-rate-recording-service.test.ts \
  packages/mobile/lib/inertial-measurement-unit-service.ts packages/mobile/lib/inertial-measurement-unit-service.test.ts \
  packages/mobile/lib/background-whoop-ble-sync.ts packages/mobile/lib/background-whoop-ble-sync.test.ts \
  packages/mobile/lib/useWhoopBleSync.ts packages/mobile/lib/useWhoopBleSync.test.ts \
  docs/superpowers/plans/2026-08-13-remove-ios-activity-recording.md
rtk git commit -m "feat: remove iOS activity recording UI"
rtk git push
```

### Task 3: Remove unused location capabilities and document the resulting app

**Files:**
- Modify: `packages/mobile/app.json:38,80-87`
- Modify: `packages/mobile/package.json:72,79`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/mobile/README.md:11-16`

**Interfaces:**
- Consumes: Expo app-config plugin schema and pnpm workspace lockfile.
- Produces: an iOS build that does not request location access or background location but retains HealthKit, Bluetooth, fetch, motion, and WatchConnectivity settings.

- [x] **Step 1: Remove only location-specific native configuration**

In `packages/mobile/app.json`, change:

```json
"UIBackgroundModes": ["bluetooth-central", "fetch", "location"]
```

to:

```json
"UIBackgroundModes": ["bluetooth-central", "fetch"]
```

Delete the entire `expo-location` plugin block, including both GPS permission
strings and `isIosBackgroundLocationEnabled`. Retain every other plugin and
native capability.

- [x] **Step 2: Remove dependencies and update the lockfile**

Remove `expo-location` and `expo-task-manager` from
`packages/mobile/package.json`, then run:

```bash
rtk pnpm install --lockfile-only
```

Expected: only their importer/resolution entries are removed; no unrelated
dependency versions change.

- [x] **Step 3: Update human-facing feature documentation**

Replace the Activity Recording README bullet with:

```md
- **Activity History**: Displays workouts and GPS routes imported from Apple
  Health and connected providers.
```

Keep the Core Motion and WatchMotion entries because passive background
synchronization still uses them.

- [x] **Step 4: Validate mobile configuration and types**

Run:

```bash
rtk pnpm --dir packages/mobile lint
rtk pnpm --dir packages/mobile typecheck
rtk pnpm --dir packages/mobile exec expo config --type public
```

Expected: each exits 0; public Expo configuration contains neither
`expo-location` nor a location background mode.

- [x] **Step 5: Confirm passive path files did not change**

Run:

```bash
rtk git diff -- packages/mobile/targets packages/mobile/modules/watch-motion \
  packages/mobile/modules/health-kit packages/mobile/lib/background-accelerometer-sync.ts \
  packages/mobile/lib/background-watch-inertial-measurement-unit-sync.ts
```

Expected: no diff. Task 2's approved type-ownership correction in
`background-whoop-ble-sync.ts` is the sole permitted passive WHOOP diff and
must not alter runtime behavior.

- [x] **Step 6: Commit and push**

```bash
rtk git add packages/mobile/app.json packages/mobile/package.json pnpm-lock.yaml packages/mobile/README.md
rtk git commit -m "chore: remove iOS activity location capability"
rtk git push
```

### Task 4: Verify the complete removal

**Files:**
- Modify: `docs/superpowers/plans/2026-08-13-remove-ios-activity-recording.md`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: fresh evidence that source, configuration, server routing, and active test tiers agree on the removal boundary.

- [x] **Step 1: Run final reference audit**

Run:

```bash
rtk rg -n "activityRecording|ActivityRecordingRepository|activity-recording|expo-location|expo-task-manager|/record(?:[\"')?]|$)" \
  packages/mobile packages/server pnpm-lock.yaml --glob '!**/*.test.ts'
```

Expected: no source/configuration output. The `/record` term matches the
literal retired route boundary, not substrings such as `record-local-time` or
`recordAccelerometer`. Historical decision records under `docs/` are
deliberately outside this audit.

- [x] **Step 2: Run final repository validation**

Run:

```bash
rtk pnpm lint
rtk pnpm typecheck
rtk pnpm test
```

Expected: each command exits 0. If a check fails, identify and fix the actual
cause; do not suppress the check or add a workaround.

- [x] **Step 3: Record verified completion**

After all commands above exit 0, replace this plan's completed checkboxes from
`- [ ]` to `- [x]` and append `## Verification Evidence` with the date and
exact commands run. State that passive watchOS behavior was preserved by source
boundary and no watchOS file changed; do not claim it was physically exercised.

- [x] **Step 4: Commit and push verification evidence**

```bash
rtk git add docs/superpowers/plans/2026-08-13-remove-ios-activity-recording.md
rtk git commit -m "docs: record activity recording removal verification"
rtk git push
```

## Verification Evidence

Verified 2026-08-13:

```bash
rtk rg -n "activityRecording|ActivityRecordingRepository|activity-recording|expo-location|expo-task-manager|/record(?:[\"')?]|$)" \
  packages/mobile packages/server pnpm-lock.yaml --glob '!**/*.test.ts'
rtk pnpm compose:up
rtk pnpm lint
rtk pnpm typecheck
rtk pnpm test
```

The reference audit emitted no source/configuration matches (its standard
no-match exit status was 1). `pnpm lint`, `pnpm typecheck`, and `pnpm test`
each exited 0. Passive watchOS behavior is preserved by the source boundary;
no watchOS file changed. Physical watchOS behavior was not exercised.
