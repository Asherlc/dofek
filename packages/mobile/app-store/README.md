# App Store screenshots and previews

## Native clinical-record review evidence

The clinical-record release candidate is accepted only when both required
display classes have native, signed-Release captures of all four screens:

| Display class | Required screens |
| --- | --- |
| 6.5-inch iPhone (`IPHONE_65`) | Today; Apple Health provider controls; Clinical Records list; Clinical Record detail |
| 13-inch iPad (`IPAD_PRO_3GEN_129`) | Today; Apple Health provider controls; Clinical Records list; Clinical Record detail |

The images must show the current app UI, not Storybook, a login screen, the
splash screen, Expo Launcher, or a development menu. Clinical screens must
show the permanent App Review account's seeded records with the visible
`Demo data — synthetic` source label. Validate current accepted dimensions
against Apple's
[screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
before every submission.

### Capture prerequisites

Before building or capturing:

1. Verify the permanent App Review account can sign in through the production
   email/password UI and still contains the deterministic synthetic review
   seed. A local `dev-session` token is not acceptable evidence. Keep the
   username and password in approved secret storage; never commit them.
2. Verify the configured API health endpoint and password-auth provider are
   reachable from both simulators. Before starting the Release capture pass,
   verify that an authenticated production `clinicalRecords.list` request succeeds
   and that the permanent account's Apple Health provider reports at least one
   clinical record. Treat a missing route or empty fixture as a blocker; do not use
   an empty/error screen as review evidence.
3. Run `asc screenshots --help`, `asc screenshots sizes --output table`,
   `asc auth status --validate`, and `xcrun simctl list devices available`.
4. Reserve an iPhone Simulator that renders an accepted 6.5-inch size and a
   13-inch iPad Simulator. Record both UDIDs with the evidence.
5. Complete the physical-iPhone authorization/query gate described in
   [the physical-device audit](../../../docs/ios-physical-device-release-audit.md).
   Simulator captures are UI evidence only. Apple documents that HealthKit
   authorization is requested through the system sheet and that read access
   is intentionally privacy-preserving
   ([HealthKit authorization](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)).

The checked-in `.asc/screenshots.json` uses
`__APP_REVIEW_EMAIL__` and `__APP_REVIEW_PASSWORD__` sentinels so credentials
cannot enter Git history. Render a private temporary plan immediately before
each run:

```bash
export APP_REVIEW_EMAIL='value from approved secret storage'
export APP_REVIEW_PASSWORD='value from approved secret storage'
umask 077
SECURE_PLAN="$(mktemp -t dofek-screenshots.XXXXXX.json)"
jq 'walk(if . == "__APP_REVIEW_EMAIL__" then env.APP_REVIEW_EMAIL elif . == "__APP_REVIEW_PASSWORD__" then env.APP_REVIEW_PASSWORD else . end)' \
  .asc/screenshots.json > "$SECURE_PLAN"
```

Delete the temporary plan after both runs. Do not print it or pass either
credential as a command-line argument.

### Build and capture

Generate the ignored native project with the production-like API and public
telemetry values, then use the signed Release Simulator build documented in
[the mobile README](../README.md#signed-release-simulator-audit). Install that
exact artifact on each reserved simulator. Run the same accessibility-driven
plan with a device-specific destination:

```bash
asc screenshots run \
  --plan "$SECURE_PLAN" \
  --udid "$IPHONE_65_UDID" \
  --output-dir packages/mobile/app-store/screenshots/native/raw/en-US/iphone-6.5 \
  --output json

asc screenshots run \
  --plan "$SECURE_PLAN" \
  --udid "$IPAD_13_UDID" \
  --output-dir packages/mobile/app-store/screenshots/native/raw/en-US/ipad-13 \
  --output json
```

The local `asc screenshots run` workflow is experimental and currently uses
AXe for accessibility polling, taps, typing, and capture. Capture fails closed
if a required screen label is absent. Re-check `asc screenshots run --help`
and inspect a fresh native accessibility snapshot before changing a selector.
Dismiss native iOS overlays such as Save Password before accepting a candidate.
If the runner reports a successful action but a fresh accessibility snapshot proves
that it did not occur, record the exact failure and obtain strategy-pivot approval
before continuing with direct AXe actions.

### Validate and review

Native screenshots are already submission-sized, so the pipeline intentionally
does not add decorative device frames. Validate both device sets locally, then
generate one review manifest over the raw candidates:

```bash
asc screenshots validate \
  --path packages/mobile/app-store/screenshots/native/raw/en-US/iphone-6.5 \
  --device-type IPHONE_65 \
  --output json

asc screenshots validate \
  --path packages/mobile/app-store/screenshots/native/raw/en-US/ipad-13 \
  --device-type IPAD_PRO_3GEN_129 \
  --output json

asc screenshots review-generate \
  --raw-dir packages/mobile/app-store/screenshots/native/raw \
  --framed-dir packages/mobile/app-store/screenshots/native/raw \
  --output-dir packages/mobile/app-store/screenshots/review \
  --output json
```

Review all eight images for dimensions, current UI, absence of login/splash
content, readable controls, and visible synthetic clinical data. Only after a
human confirms the exact final media set, run local approval and the remote
plan/apply workflow. Never run `asc screenshots apply`, `upload`, or a media
replacement command without that explicit confirmation. App Store Connect's
[media workflow](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
is the source of truth for the final upload.

### App Review information

The App Review Information fields must use the permanent reviewer username and
password. The review notes must contain all of the following, with current
navigation wording:

- All clinical data visible in the review account is deterministic synthetic
  demo data and does not identify a real person.
- Apple Health is opt-in: open **More → Account & settings → Data Sources →
  Apple Health**, then choose **Connect** or **Sync** and select the desired
  read permissions in Apple's system sheet.
- To remove Dofek-held Apple Health data, open the Apple Health provider
  detail, scroll to **Danger Zone**, choose **Delete All Data**, and complete
  the explicit confirmation. Disconnecting Apple Health or revoking access in
  iOS stops future collection but is separate from deleting the authenticated
  account's stored copy.
- Clinical records are uploaded over HTTPS, stored in the authenticated
  application's canonical PostgreSQL clinical-record store, and accessible
  only through the user's authenticated account and authorized operational
  access. They are not used for advertising or tracking.

Preserve any still-current physical-device video, support URL, and unrelated
review guidance when updating these notes.

## Screenshots (automated)

Screenshots are generated from mobile Storybook page stories with seeded mock data.

```bash
# From repo root
pnpm storybook:mobile:build
pnpm --filter dofek-mobile app-store:screenshots

# Or one command from packages/mobile
pnpm app-store:assets
```

Output: `packages/mobile/app-store/screenshots/` (1284×2778 PNGs for 6.5" display).

### Upload order (App Store Connect)

| File | Suggested caption overlay |
|------|---------------------------|
| `01-today-readiness.png` | See your daily readiness at a glance |
| `02-recovery-trends.png` | Track HRV, resting heart rate, and recovery trends |
| `03-training-load.png` | Balance training load with recovery |
| `04-activities-map.png` | Review every workout with route previews |
| `06-connected-providers.png` | Connect Strava, WHOOP, Apple Health, and more |
| `07-heart-rate-zones.png` | Inspect heart rate zone distribution |

The generator's 1284×2778 output is an accepted 6.5-inch portrait size. Apple
accepts one to ten screenshots and can scale accepted sizes for other iPhone
displays; consult Apple's current
[screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
before each submission because supported devices and sizes change.

Caption overlays are optional. If you add them, preserve the generated image
dimensions and export an opaque PNG or JPEG; App Store screenshots cannot have
an alpha channel.

## App previews (video)

App previews are **not** generated by this script. Record them manually:

1. Open an iOS Simulator whose output size matches Apple's current
   [app preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications).
2. Run the app with realistic data, or use on-device Storybook (`pnpm storybook:mobile:ios`).
3. Record with **QuickTime → File → New Screen Recording** (select the simulator window) or `xcrun simctl io booted recordVideo preview.mp4`.
4. Keep each clip **15–30 seconds**, portrait, showing one feature per preview.
5. Export using a resolution and codec from Apple's current
   [app preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications).

Suggested preview sequence:

1. **Today tab** — scroll through readiness, sleep, and strain cards.
2. **Activities** — open a workout, show map and stats.
3. **Nutrition** — review nutrition history, totals, and analytics.

Apple permits up to three app previews per supported device size. Follow the
[App Store Connect upload workflow](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)
for the current submission steps.

## Higher-fidelity option

Storybook web renders are good for layout and copy. For final submission assets with native fonts and tab bar:

1. Run the production app in Simulator with a seeded account.
2. Capture with `xcrun simctl io booted screenshot screenshot.png`.
3. Replace or supplement the automated PNGs above.

Do not maintain a second hard-coded device-size table here. Apple's
[screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
are the source of truth for accepted resolutions and fallback scaling.
