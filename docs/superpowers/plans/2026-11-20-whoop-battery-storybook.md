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

- Pending implementation and validation.
