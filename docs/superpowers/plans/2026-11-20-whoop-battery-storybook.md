# WHOOP battery badge Storybook plan

**Approved scope:** The user chose variant B and requested a real Storybook
story, shown in Paseo without desktop control. Implement the presentation with
fixtures first; native battery acquisition remains a separate subsequent task.

**Goal:** Preview the chosen WHOOP battery badge in the existing mobile
Bluetooth device list with explicit charging, not-charging, zero, low, unknown,
and disconnected stories.

**Architecture:** Extend the WHOOP device presentation type with an optional
`battery` object containing nullable `percentage` and `isCharging`. Existing
native catalog results can omit it until native acquisition is implemented.
The existing list renders the right-aligned battery badge only when that object
is supplied, and stories supply deterministic fixtures. No server changes,
native changes, new dependencies, or bespoke preview infrastructure are needed.

**Reference:** [Approved design](../specs/2026-11-19-whoop-ble-battery-status-design.md)
and [selected canvas artboard](../../../design/whoop-battery-status/badge.html).

## Tasks and acceptance

1. Update `packages/mobile/components/BluetoothDeviceList.test.tsx` with failing
   assertions for percentage and each charging state, including measured zero,
   unknown, and disconnected readings. Verify the new cases fail first.
2. Add the optional WHOOP-only battery field in
   `packages/mobile/lib/bluetooth-device-catalog.ts`, and implement the compact
   percentage pill and separate charging label in `BluetoothDeviceList.tsx`.
   Keep the current row callbacks, diagnostic content, loading, empty, and error
   behavior. Disconnected rows must display unavailable rather than stale data.
   Preserve screen-reader access to both battery facts and device selection.
3. Extend `BluetoothDeviceList.stories.tsx` with `BatteryBadge` and all significant
   state variants. Reuse the real component and existing mobile Storybook setup;
   the main story shows WHOOP MG at 57%, Charging, alongside Polar H10.
4. Run focused non-interactive mobile tests, lint, and all-package typechecks.
   Start mobile Storybook through its existing CLI, verify the live index and
   direct story response, and open the exact story using Paseo's Storybook tools.
   Review the actual diff, fix findings, then commit and push automatically.

## Review focus

- A valid 0% reading is preserved rather than treated as missing.
- `false` means “Not charging”; `null` means “Charging unknown”.
- Disconnecting does not present an earlier reading as current.
- Long unavailable labels fit the right-hand column at mobile widths.
- Existing native builds and callers that omit battery retain their behavior.

## Evidence

- Completed the four scoped files. The real list renders the selected B badge
  when a WHOOP battery object is present; older catalog snapshots omit it.
- Nine new regression cases failed before implementation. All 15 focused cases
  then passed; the full mobile tier passed 227 files and 2,473 tests.
- `pnpm lint` and all-package typechecks passed. Lint retained existing broken
  skill-symlink warnings and configured SQL large-file skips.
- The mobile Storybook build passed. Existing unrelated Expo Updates mock-export
  warnings remain in its output. All six battery stories appear in the live
  index, and the exact main story response returned HTTP 200.
- Independent review found a normal-badge contrast issue. Replacing its colors
  with the existing operational success pair resolved it; follow-up review found
  no remaining material findings. Focused Biome and mobile typecheck passed after
  that final palette-only correction.
- Preview URL: <http://127.0.0.1:6007/?path=/story/settings-bluetoothdevicelist--battery-badge>.
  The user opens it themselves. No screen or browser control was used for the
  Storybook task; visual verification of the Storybook render remains theirs.
- Retrospective: the existing component and Storybook configuration covered the
  presentation without new dependencies. Contrast needed a review correction;
  prefer the existing operational color pairs for small status text next time.
  Native acquisition and its protocol/device validation remain pending.
