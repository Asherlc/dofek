# WHOOP BLE battery status

## Intent and scope

The user requested WHOOP BLE battery status and confirmed that it must include
both battery percentage and charging state. Show these alongside the current
connection in the mobile Bluetooth device list and WHOOP device detail screen.
This is local native device status; the web client has no connection to the
phone's Bluetooth peripheral. No server storage, ingestion, or battery history
is needed.

## Approach

Use the standard Battery Service (`180F`) and Battery Level characteristic
(`2A19`) for an initial percentage read and supported notifications. Use
capture-backed WHOOP battery events for charging state and their accompanying
percentage. The standard characteristic alone cannot meet the confirmed
charging requirement. Proprietary battery command polling would add another
command lifecycle without removing the need for charging events, so it is not
proposed.

The Bluetooth SIG defines [Battery Level behavior](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/BAS_v1.1/out/en/index-en.html).
The [WHOOP MG capture report](https://github.com/megablocks/openwhoop/blob/main/whoop-mg-protocol-analysis.md#1-gatt-service-map)
observes the standard characteristic with read and notify properties.
The upstream [WHOOP 5 event research](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/BLE_REVERSE_ENGINEERING.md#whoop-50-event-type-48)
documents repeatable battery events, their framing, percentage scaling, and
charging flag. Protocol facts may inform an independent implementation;
do not copy upstream implementation code.

## Behavior and boundaries

- Read and subscribe within the existing Swift connection manager. Optional
  battery services and events must not become prerequisites for sensor readiness.
- Decode validated WHOOP frames in Swift, using an independently written parser
  and minimal captured fixtures with source provenance. Do not guess unsupported
  packet layouts or claim generation compatibility without evidence.
- Expose nullable battery percentage and charging state through the existing
  device summary and device-state event. Preserve compatibility with older native
  builds that omit the new fields.
- Render a compact percentage and “Charging” / “Not charging” label. Represent
  unknown readings explicitly; never infer charging from a rising percentage.
- Clear readings on disconnect and device replacement, so an earlier session
  cannot appear current. Report unexpected errors through existing reporting.
- Keep battery status in memory. No timers, server APIs, database changes,
  estimates, battery-pack status, or low-battery notifications are proposed.

## Acceptance criteria and task order

1. Add failing Swift regressions for real battery events, charging transitions,
   malformed frames, optional service discovery, updates, and disconnect reset.
2. Implement the smallest native change, including the Expo bridge and existing
   device summary; verify the regressions pass.
3. Add failing TypeScript/mobile tests, then carry the values through the device
   catalog and both existing screens. Update affected stories for charging,
   not-charging, unknown, and zero-percent readings.
4. Update the native README and canonical protocol reference with sources and
   the requirement for a new native build. Review the whole diff independently
   when an authorized reviewer is available.
5. Run focused Swift and non-interactive mobile tests, full lint, all-package
   typechecks, and an iOS build for the Expo bridge. Commit and push each
   meaningful completed chunk. Clearly separate automated evidence from the
   physical strap check needed to verify live charging changes.

Implementation choices within these boundaries are left to the builder. The
lead owns protocol evidence, architecture, actual-diff review, and validation.
