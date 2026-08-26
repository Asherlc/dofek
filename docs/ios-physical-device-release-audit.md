# iOS Physical-Device Release Audit

Use this runbook for every iOS release candidate before App Store submission
or production approval. It complements the
[signed Simulator audit](../packages/mobile/README.md#signed-release-simulator-audit);
Simulator evidence cannot replace the hardware checks below.

The canonical candidate is the signed Release build uploaded by
[`deploy-ios.yml`](../.github/workflows/deploy-ios.yml) through
[`ExportOptions.plist`](../packages/mobile/build/ExportOptions.plist).
TestFlight assigns builds to tester groups and installs a device-specific
variant, so record the exact version and build selected in TestFlight before
testing. Apple documents that flow in the
[TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
and
[internal tester guide](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).

## Release gate

Create one release-audit issue or checklist for the candidate. Copy the
[evidence template](#evidence-template), record every required row as `Pass` or
`Blocked`, and link failures to an issue with reproduction evidence. Do not
approve the release with a `Fail`, an unexplained blank, or a local development
build standing in for the TestFlight candidate.

A locally signed build from the same commit is useful for debugger-assisted
diagnosis. Reproduce the fix on the exact TestFlight build before changing a
matrix row to `Pass`.

### Stable hardware lanes

The matrix names capabilities and OS lanes rather than Apple model numbers.
Record the actual device model and OS version in each audit:

| Lane | Required hardware | Purpose |
|---|---|---|
| Compatibility | A physical iPhone running the oldest OS version Dofek claims to support; add a paired Watch on the oldest claimed watchOS version when Watch code or configuration changed | Detect deployment-target and older-runtime regressions |
| Current | A physical iPhone on the current production iOS release, a paired Apple Watch on the current production watchOS release that supports the audited sensors, a Bluetooth SIG Heart Rate Service monitor, and a dedicated supported WHOOP strap | Exercise every hardware integration and background lifecycle |

The deployment floors are currently iOS 16.4 in
[`app.json`](../packages/mobile/app.json) and watchOS 10.0 in the
[Watch target configuration](../packages/mobile/targets/DofekWatch/expo-target.config.js).
If the team cannot retain hardware on an OS version it still claims to support,
record that coverage gap as a release blocker or explicitly change the
supported deployment target in a separate reviewed change. Do not silently
substitute Simulator coverage.

## Synthetic-only audit setup

Keep three identities separate:

1. **TestFlight tester:** Use a team-controlled Apple Account enrolled in the
   internal TestFlight group. Grant only the App Store Connect access needed
   for internal testing; never share an individual's Apple Account.
2. **Dofek audit account:** Register a dedicated Dofek email/password account
   through the normal app flow and grant any required access through the normal
   billing/admin workflow. Store its credential in approved secret storage,
   not in this repository, release issues, screenshots, or logs.
3. **Audit hardware:** Use a dedicated iPhone and Watch whose Health store,
   Bluetooth pairings, photos, contacts, and notifications contain no personal
   data.

The audit account and devices must remain synthetic:

- Use a clearly fictional name, birth date, measurements, meals, workouts, and
  Health entries. Do not clone a real user's history.
- Do not sign into personal Apple, Google, or provider accounts. Do not connect
  production WHOOP, Strava, Garmin, or other personal provider credentials.
- Reserve the lab heart-rate monitor and WHOOP strap for test capture. Clear
  or label stored sessions according to the device vendor's test procedure.
- Enter the minimum Health samples needed for the current run manually on the
  audit device after noting their timestamps. HealthKit authorization is
  per-type and user-controlled; Dofek must not assume that read access was
  granted. Apple documents this privacy boundary in
  [Protecting user privacy](https://developer.apple.com/documentation/healthkit/protecting-user-privacy).
- Use a packaged retail barcode that contains no user data. Record only the
  barcode type and whether lookup succeeded, not a photo containing unrelated
  surroundings.

Never run `pnpm seed` against production to populate this account.
[`seed-dev-db.ts`](../scripts/seed-dev-db.ts) is explicitly a local
development/review-database tool, and its cleanup uses fixed reviewer user and
provider identifiers. Populate the audit account only through supported user
flows or an independently reviewed, production-safe operator procedure.

Before each candidate:

1. Confirm the device is signed into the team TestFlight identity and install
   the exact candidate from TestFlight.
2. Sign into the dedicated Dofek audit account. Do not reuse an authenticated
   install from a personal account.
3. Record the existing synthetic Health samples and Dofek data that will be
   used. Add fresh, timestamped samples for observer/background checks.
4. Reset only the permission whose first-run path is being tested. Apple notes
   that camera authorization is persisted and can be changed in system privacy
   settings; test both denial handling and a granted scan when camera-related
   code or configuration changed:
   [camera authorization](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media).
5. Start device Console/Sentry/server-log observation without recording
   credentials, Health values, device serial numbers, UDIDs, or tokens.

## Physical-device matrix

Run every `Every RC` row for every candidate. Run conditional compatibility
rows when the named native area, entitlement, deployment target, dependency, or
app configuration changed. A release owner may expand the matrix for a
high-risk change, but must not remove required rows.

| ID | Capability and lane | Frequency | Procedure | Pass evidence |
|---|---|---|---|---|
| IOS-PHY-01 | Install, cold launch, authentication — Compatibility + Current | Every RC | Install the exact TestFlight build, cold-launch it, sign into the audit account, background and foreground it, then force-quit and relaunch | Version/build match the candidate; a real app screen renders; session survives the supported lifecycle; no new fatal app error |
| IOS-PHY-02 | HealthKit authorization and foreground import — Compatibility + Current | Every RC | Exercise the connect flow, choose the intended permissions, add a fresh synthetic sample, and sync | Permission state is actionable; the sample appears once with the expected source/timestamp; denial does not masquerade as success |
| IOS-PHY-03 | HealthKit observer delivery — Current | Every RC | Background and lock the phone, create or import a fresh synthetic sample of an observed type, then unlock when needed for the protected Health store and wait for observer-driven sync or retry to settle | Native update ID/type, query, upload, and completion evidence exists; protected-store unavailability is explicit and eventually retries; the update completes once without native expiration |
| IOS-PHY-04 | Bluetooth SIG heart-rate monitor — Current | Every RC | Pair/connect the lab monitor, capture heart rate and R-R data in foreground, then lock/background the phone while the monitor continues transmitting | Ready state follows notification subscription; samples continue with the expected device attribution; buffered upload is confirmed only after success |
| IOS-PHY-05 | WHOOP BLE — Current | Every RC | Discover and connect the lab WHOOP, start the supported realtime stream, background/lock the phone, return, and flush the buffer | Connection/stream state is actionable; new device-attributed samples upload; no unexplained watchdog, disconnect, or buffer-loss error |
| IOS-PHY-06 | iPhone Core Motion — Current | Every RC | Verify availability, exercise first authorization on a clean permission state when required, record motion, background/lock the phone, then query and upload retained samples | Availability and authorization are explicit; new timestamped samples are returned and uploaded without advancing the cursor before success |
| IOS-PHY-07 | Watch recording and transfer — Current phone + paired Watch | Every RC | Install/open the companion, record accelerometer and altitude data, queue a transfer, background both apps, then reopen the phone and sync pending files | Pair/install/reachability states are visible; both file types persist until successful upload and are deleted only after confirmation |
| IOS-PHY-09 | Background refresh registration and lifecycle — Current | Every RC | Confirm Background App Refresh is available, background/lock the app during the matrix, and inspect logs for registration, submission, expiration, or completion errors | No registration/submission failure or crash occurs; any delivered task completes exactly once after required work settles |
| IOS-PHY-10 | Compatibility native smoke — Compatibility | When native module/config/deployment target changes | Repeat the changed capability on the compatibility lane | The changed capability passes on the oldest claimed OS without availability assumptions or unsupported API failure |
| IOS-PHY-11 | Post-run telemetry — Current | Every RC | Review device, Sentry, and server evidence after all paths | No unexplained fatal error, privacy-sensitive log value, repeated completion, or stuck upload remains |

HealthKit observer background delivery is not supported in Simulator, and
Apple explicitly requires device testing:
[executing observer queries](https://developer.apple.com/documentation/healthkit/executing-observer-queries).
Core Bluetooth background behavior is constrained after suspension even when
the app declares the central background mode:
[Core Bluetooth background processing](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html).
Core Motion services vary by device, so the audit must record availability
instead of assuming it:
[Core Motion](https://developer.apple.com/documentation/coremotion).
Apple's Watch Connectivity sample requires a physical iPhone and Watch and
describes background file-transfer handling:
[transferring data with Watch Connectivity](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity).

`BGAppRefreshTask` execution is scheduled by the system; the requested earliest
date is not a delivery deadline. Do not fail or pass IOS-PHY-09 solely because
no discretionary launch occurred during a short test window. Registration,
submission, lifecycle safety, and exact-once completion remain required. If
background-refresh code or configuration changed, keep the candidate blocked
until one OS-delivered task is observed on a physical device or the release
owner records the external scheduling limitation and an explicit risk
decision. Apple describes app refresh as system-run background work:
[`BGAppRefreshTask`](https://developer.apple.com/documentation/backgroundtasks/bgapprefreshtask).

## Failure evidence

For a failed row, capture:

- release version, build number, commit SHA, matrix ID, lane, device model, and
  OS version;
- exact action and lifecycle state (`foreground`, `background`, `locked`,
  `terminated`);
- first fatal or behavior-defining log line;
- app-visible message and whether retry/relaunch changed the result;
- Sentry issue/event or sanitized server-log link;
- the smallest reproduction sequence and linked GitHub issue.

Do not attach screenshots or logs that expose Health values, email addresses,
Apple Accounts, device names, serial numbers, UDIDs, IP addresses, tokens, or
provider credentials.

## Evidence template

```markdown
## iOS physical-device release audit

| Field | Value |
|---|---|
| App version / TestFlight build | |
| Commit SHA / Deploy iOS run | |
| Audit date / owner | |
| Compatibility device / OS | |
| Current device / OS | |
| Watch / watchOS | |
| BLE HR monitor label | |
| WHOOP lab-device label / firmware | |
| Synthetic Dofek account label | |

| Matrix ID | Result (`Pass`, `Blocked`, or conditional `Not required`) | Evidence or linked issue |
|---|---|---|
| IOS-PHY-01 | | |
| IOS-PHY-02 | | |
| IOS-PHY-03 | | |
| IOS-PHY-04 | | |
| IOS-PHY-05 | | |
| IOS-PHY-06 | | |
| IOS-PHY-07 | | |
| IOS-PHY-08 | | |
| IOS-PHY-09 | | |
| IOS-PHY-10 | | |
| IOS-PHY-11 | | |

Release decision: `Approved` or `Blocked`
Decision owner:
Open blockers:
```
