# Task 7 report: native clinical-record review evidence

Date: 2026-08-29

Status: partially complete; documentation, capture configuration, reviewer-account
verification, Release build, one iPhone capture, and App Store Connect review-note
updates are complete. The remaining simulator captures require approval to switch
from the defective `asc screenshots run` tap execution to direct AXe. The separate
physical-iPhone HealthKit acceptance gate is blocked because the paired iPhone is
unavailable to Xcode.

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

No screenshot was uploaded, planned, applied, or attached in App Store Connect. No
incomplete local review manifest was approved.

## Verified prerequisites

| Check | Result |
| --- | --- |
| `asc auth status --validate` | Valid App Store Connect keychain credential |
| Permanent review login | Production password-auth endpoint returned HTTP 200; only status booleans were emitted |
| `asc screenshots sizes --output table` | `IPHONE_65` accepts 1242x2688; `IPAD_PRO_3GEN_129` accepts 2048x2732 |
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
| iPhone 6.5 | Captured, 1242x2688 | Blocked | Blocked | Blocked |
| iPad 13 | Not run | Not run | Not run | Not run |

The valid partial candidate is
`packages/mobile/app-store/screenshots/native/raw/en-US/iphone-6.5/01-today.png`.
It contains authenticated native UI and no login, splash, Expo Launcher, or
development-menu content.

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

The remaining automation failure is reproducible:

```text
Error: screenshots run: step 15 (wait_for): wait_for timed out after 15000ms
```

At that point the preceding `tap` step targets `More`, but the app remains on Today.
The live accessibility tree contains exactly one enabled `More` `AXButton` at
`{{359,46.7},{46,38.7}}`. A direct
`axe tap --label More --udid AA78427D-0CAB-4F95-864E-7817CED14BA6` navigates to
the expected screen immediately. The same `asc screenshots run` failure persisted
after a two-second pre-tap wait and a reset of the isolated simulator's app container
and Keychain. The current asc-runner strategy is therefore exhausted at a tool tap
defect. Per the repository's mandatory strategy-pivot gate, direct AXe execution has
been proposed and is awaiting explicit approval.

## Validation performed

- `jq empty .asc/screenshots.json .asc/shots.settings.json`
- `asc screenshots --help`
- `asc screenshots run --help`
- `asc screenshots sizes --output table`
- `asc auth status --validate`
- `xcrun simctl list devices available`
- Release `xcodebuild` retry: exit 0
- `xcrun simctl install` and `get_app_container` on both reserved simulators
- `sips -g pixelWidth -g pixelHeight` on the iPhone Today candidate: 1242x2688
- Reviewer login availability check: HTTP 200 without logging credentials
- App Store Connect review-detail re-read after update
- `git diff --check`

Dedicated tests were not added for the declarative JSON or documentation, consistent
with the repository rule against testing static configuration files.

## Retrospective

The credential-safe reviewer login, accepted simulator sizes, isolated devices,
native Release artifact, and exact first-failure evidence all made the workflow
auditable. Native inspection was necessary to separate an app validation failure
from an asc automation defect. Next time, the capture runbook should state that
simulator Keychain state survives app uninstall and document the `rtk proxy` rule
for secret-bearing JSON pipelines. A short AXe fallback section, gated by the
strategy-pivot rule, would also reduce recovery time when asc reports a successful
tap that does not activate the target.

For similar work, use `asc-shots-pipeline` and `ios-simulator-audit` again. A small
repository skill for credential-safe App Store reviewer-account capture would close
the remaining workflow gap.
