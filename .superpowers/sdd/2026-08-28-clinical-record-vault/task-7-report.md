# Task 7 report: native clinical-record review evidence

Date: 2026-08-29

Status: partially complete; documentation, capture configuration, reviewer-account
verification, Release build, four native captures, and App Store Connect review-note
updates are complete. The Clinical Records list/detail captures are blocked because
the production server returns 404 for `clinicalRecords.list` and the permanent
review account has zero seeded clinical records. The separate physical-iPhone
HealthKit acceptance gate is blocked because the paired iPhone is unavailable to
Xcode.

## Durable work completed

- Added direct acceptance criteria and a credential-safe native capture runbook to
  `packages/mobile/app-store/README.md` for the 6.5-inch iPhone and 13-inch iPad.
- Linked the evidence workflow from `packages/mobile/README.md` and cited Apple's
  [screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
- Added `.asc/shots.settings.json` with framing and upload disabled.
- Added `.asc/screenshots.json` for permanent-review-account sign-in followed by
  Today, Apple Health provider controls, Clinical Records list, and Clinical Record
  detail captures. Credentials remain sentinels in Git and are rendered only into a
  mode-600 temporary plan.
- Updated App Store Connect version 1.0 review detail
  `c65b153a-9a15-45b4-9fc7-53d891ac85b2`. The existing demo video, Bluetooth,
  location, clinical-record storage/access, privacy, and support text was preserved;
  explicit synthetic-review-data disclosure and the in-app provider-data deletion
  path were added.
- Built the production-server Release configuration successfully for the arm64 iOS
  Simulator and installed the same artifact on both reserved simulators.
- Captured and visually inspected authenticated Today and Apple Health provider
  controls on both display classes. The provider controls show the optional,
  read-only clinical-record explanation and the Danger Zone deletion action.

No screenshot was uploaded, planned, applied, or attached in App Store Connect. No
incomplete local review manifest was approved.

## Verified prerequisites

| Check | Result |
| --- | --- |
| `asc auth status --validate` | Valid App Store Connect keychain credential |
| Permanent review login | Production password-auth endpoint returned HTTP 200; only status booleans were emitted |
| `asc screenshots sizes --output table` | `IPHONE_65` accepts 1242x2688; `IPAD_PRO_3GEN_129` accepts the captured 2064x2752 size |
| AXe | 1.8.0 installed |
| iPhone Simulator | iPhone 11 Pro Max, `AA78427D-0CAB-4F95-864E-7817CED14BA6` |
| iPad Simulator | iPad Pro 13-inch (M5), `8DD82424-FB13-4431-80A8-DB54F1990FA8` |
| Release build | `xcodebuild` exit 0 with `ONLY_ACTIVE_ARCH=YES ARCHS=arm64` |
| Physical iPhone | Paired device listed as unavailable; authorization/query gate not executed |

The physical gate remains mandatory because simulator UI cannot prove HealthKit
authorization or record queries. Apple's authorization behavior is documented in
[Authorizing access to health data](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data).

## Capture result

| Display class | Today | Provider controls | Clinical list | Clinical detail |
| --- | --- | --- | --- | --- |
| iPhone 6.5 | Captured, 1242x2688 | Captured, 1242x2688 | Blocked | Blocked |
| iPad 13 | Captured, 2064x2752 | Captured, 2064x2752 | Blocked | Blocked |

The four valid partial candidates are under
`packages/mobile/app-store/screenshots/native/raw/en-US/{iphone-6.5,ipad-13}`.
They contain authenticated native UI and no login, splash, password-save prompt,
Expo Launcher, or development-menu content. No empty or error screen was accepted
as clinical evidence.

## Exact software blocker

The first Release build failed with exit 65. Its first fatal line was:

```text
error: The file “swbuild.tmp.9rxN7TcZ” couldn’t be saved in the folder “arm64”.
```

The data volume had 116 MiB available and the failed Task 7 DerivedData occupied
6.0 GiB. Removing only disposable workspace-local DerivedData and rebuilding for
the active arm64 Simulator architecture resolved the root cause; the retry exited
0 without an added timeout or retry knob. Docker builder-cache pruning was also
attempted as documented by the repository, but the Docker socket ping timed out.

The first screenshot run then exposed truncated accessibility typing: the native
screen contained `test@test.` and showed `Enter a valid email address.`. Explicit
settling waits after text entry resolved that failure and the subsequent clean run
authenticated and captured Today.

The asc automation failure was reproducible:

```text
Error: screenshots run: step 15 (wait_for): wait_for timed out after 15000ms
```

At that point the preceding `tap` step targets `More`, but the app remains on Today.
The live accessibility tree contains exactly one enabled `More` `AXButton` at
`{{359,46.7},{46,38.7}}`. A direct
`axe tap --label More --udid AA78427D-0CAB-4F95-864E-7817CED14BA6` navigates to
the expected screen immediately. The same `asc screenshots run` failure persisted
after a two-second pre-tap wait and a reset of the isolated simulator's app container
and Keychain. The asc-runner strategy was therefore exhausted at a tool tap defect.
After explicit approval, the remaining valid navigation and captures were completed
with direct AXe commands against fresh accessibility snapshots. Credentials were
typed via standard input rather than exposed as command arguments. The iPad's native
Save Password prompt was dismissed before recapturing and visually inspecting Today.

The remaining blocker is production state, not simulator automation. The permanent
review account's Apple Health screen reports `No records yet for this provider`, and
its provider statistics report zero clinical records. The production UI intentionally
shows `View clinical records` only when `clinicalRecords > 0`. A credential-safe
authenticated production request to `clinicalRecords.list` returned HTTP 404, while
the current branch registers that router. The deterministic review fixture exists in
the repository seed code but has not been applied to the permanent production review
account. Capturing valid list/detail evidence therefore requires deployment of the
current server and an authorized production seed operation. Neither production
mutation was performed as part of this capture task.

## Validation performed

- `jq empty .asc/screenshots.json .asc/shots.settings.json`
- `asc screenshots --help`
- `asc screenshots run --help`
- `asc screenshots sizes --output table`
- `asc auth status --validate`
- `xcrun simctl list devices available`
- Release `xcodebuild` retry: exit 0
- `xcrun simctl install` and `get_app_container` on both reserved simulators
- `asc screenshots validate` on the iPhone directory: two ready, zero errors or warnings
- `asc screenshots validate` on the iPad directory: two ready, zero errors or warnings
- `sips -g pixelWidth -g pixelHeight` on all candidates: iPhone 1242x2688; iPad 2064x2752
- Reviewer login availability check: HTTP 200 without logging credentials
- Authenticated production `clinicalRecords.list` availability check: HTTP 404 without logging credentials
- App Store Connect review-detail re-read after update
- `git diff --check`

Dedicated tests were not added for the declarative JSON or documentation, consistent
with the repository rule against testing static configuration files.

## Retrospective

The credential-safe reviewer login, accepted simulator sizes, isolated devices,
native Release artifact, and exact first-failure evidence made the workflow
auditable. Native inspection separated app behavior, an asc automation defect, an
iOS password-save overlay, and missing production prerequisites. Next time, verify
the production clinical router and permanent-account fixture before starting the
expensive Release capture pass. The runbook should also state that simulator
Keychain state survives app uninstall, describe dismissal of native password-save
prompts, and document the `rtk proxy` rule for secret-bearing JSON pipelines. A
short AXe fallback section, gated by the strategy-pivot rule, would reduce recovery
time when asc reports a successful tap that does not activate the target.

For similar work, use `asc-shots-pipeline` and `ios-simulator-audit` again. A small
repository skill for credential-safe App Store reviewer-account capture would close
the remaining workflow gap.
