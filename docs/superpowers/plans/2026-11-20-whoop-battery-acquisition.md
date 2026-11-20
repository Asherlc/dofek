# Live WHOOP battery acquisition

**Approved scope:** The user approved the battery badge and explicitly requested
live acquisition of both percentage and charging state. No desktop, browser,
window, or simulator UI control is authorized or needed for this work.

**Spec:** [Battery status design](../specs/2026-11-19-whoop-ble-battery-status-design.md).

## Architecture and evidence

- Discover the optional standard Battery Service (`180F`), read its one-byte
  Battery Level (`2A19`, 0–100), and subscribe when supported. The Bluetooth SIG
  specifies [Battery Level behavior](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/BAS_v1.1/out/en/index-en.html).
- Identify the family from this connection before choosing the standard source.
  Exclude Harvard/WHOOP 4 because its standard level is a documented stub with
  incorrect values; see the pinned [battery-source evidence](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/android/app/src/main/java/com/noop/ble/BatterySource.kt#L17-L30).
  Leave unsupported Harvard readings unknown rather than adding command polling.
- Subscribe to the WHOOP event characteristic (service suffix `0004`) separately
  from the required data/command subscriptions. Battery failures must not abort
  the sensor handshake or satisfy its readiness tracker.
- Feed that characteristic through its own existing frame-parser instance, then
  decode validated type `0x30` battery events in Swift. The manager owns the
  resulting nullable percentage/charging state on its BLE queue and immediately
  notifies the Expo bridge when either fact changes. Reset state and parser on
  disconnect/replacement. Do not add timers, command polling, storage, or APIs.
- Protocol facts come from the pinned upstream [WHOOP 5 event capture](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/Packages/WhoopProtocol/Tests/WhoopProtocolTests/Whoop5EventTests.swift)
  and the multiple battery records in its [upstream fixtures](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/Packages/WhoopProtocol/Tests/WhoopProtocolTests/Resources/frames.json).
  Copy only the minimal raw packet facts with provenance, not upstream source.
  The Maverick envelope uses event number at payload byte 2, event body length
  at byte 10, battery decipercent at byte 13, and charging bit 0 at byte 22.
  The upstream [protocol reference](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL.md)
  also names charging-on/off events 7/8; initial charging stays unknown until a
  supported event is observed. Do not claim new Harvard transport support.

## Task order and acceptance

1. Add failing Swift regressions for captured battery events, charging changes,
   percentage bounds, malformed/fragmented frames, and non-battery events. Add a
   focused decoder beside the existing frame parser if needed to keep its file
   under the repository size limit. Preserve the existing frame/CRC validation.
2. Add failing manager regressions, then implement optional discovery/read/notify,
   current-peripheral ownership, optional failure isolation, immediate updates,
   and disconnect/replacement cleanup. Verify missing battery services and failed
   optional subscriptions leave the required readiness lifecycle intact. Keep
   the standalone Swift client conforming to the delegate contract.
3. Add nullable `battery` to the native device summary/event and TypeScript Zod
   schema, defaulting older native summaries to null facts. Map it into the real
   device catalog. Reuse the selected badge in list and device details; cover
   updates, unknown/false/zero and stale disconnect handling with failing tests
   before implementation. Preserve existing Storybook variants.
4. Update the native README and canonical protocol reference with cited sources,
   unsupported/unknown semantics and the requirement for a new native binary.
5. Run the complete Swift package suite, relevant non-interactive mobile tests,
   full lint and all-package typechecks. Generate/build an iOS development target
   through the documented Expo/Xcode CLI workflow to compile the real bridge,
   without opening any app UI. Obtain independent final diff review, fix material
   findings, commit and push. Report any unperformed physical-strap verification
   explicitly; simulator or compiler success cannot prove hardware delivery.

## Review focus

- Battery values from an old peripheral or old connection cannot repopulate a
  replacement session, including late notification/discovery callbacks.
- Standard and proprietary updates preserve the other known fact rather than
  replacing it with an invented false/zero default.
- Optional errors, duplicate updates and malformed data do not disturb streaming.
- Readiness/restoration still depends only on the existing required channels.
- Bridge events stay on the main thread and BLE state remains queue-confined.

## Evidence

- Native regressions failed before implementation. A subsequent malformed-event
  regression exposed missing body-length validation; the decoder now excludes
  the CRC trailer and validates the declared body length. The Harvard regression
  reproduced the incorrect 81% standard reading before the family guard.
- The complete Swift package suite passed: 266 tests, zero failures. The captured
  49.9%, off-charger packet is distinct from synthetic charging/malformed cases.
- Bridge/catalog/UI regressions failed before wiring. The complete mobile suite
  passed: 228 files, 2,488 tests. After the final detail-card wrapping change,
  its 17 focused detail/shared-badge tests passed again.
- Root `pnpm lint`, all-package typechecks, and the mobile Storybook production
  build passed. Final layout edits also passed focused Biome and mobile typecheck.
- SwiftLint passed for all 199 repository-owned mobile Swift files. The local
  dependency installation also exposes linked Expo dependency sources to a bare
  recursive scan; linting the Git-owned source inventory avoids linting those
  external files without changing repository exclusions.
- Periphery completed using Swift's stock `--build-system native` selection;
  the local Swift 6.3 default otherwise places its index outside Periphery's
  expected path. No new unused battery declarations remain. Existing warnings
  concern diagnostic/store properties whose Expo consumers are outside SwiftPM.
  This was a local check invocation, not a repository build-setting change.
- Independent whole-change review found an incorrect Harvard standard source and
  a potential large-text detail-card overflow. Both fixes were reviewed again;
  no material findings remain. The normal badge's success palette was already
  verified at 8.30:1 text contrast in both appearances.
- The full iOS development build passed through Xcode CLI: `Dofek`, Debug,
  generic iOS Simulator destination, both arm64 and x86_64, documented fixture
  configuration and ad-hoc signing. The current WHOOP module and Expo bridge
  compiled in both architectures. No app or simulator UI was opened or driven.
- The new Expo runtime regression for explicit null, zero, and false is present
  in the existing app-hosted bridge suite but was not executed. SwiftPM excludes
  that suite; the app build compiles the production Expo bridge only. Physical
  strap delivery, firmware compatibility, and Dynamic Type rendering also remain
  unverified. Live acquisition requires a rebuilt native binary; old binaries
  continue to display unknown readings.

## Retrospective

The existing connection manager, frame parser, Expo snapshot/event path, and
shared badge were sufficient; no polling, server storage, dependency, or new
operational tooling was needed. Captured packets and red/green regressions made
the CRC boundary and WHOOP 4 stub issue concrete. For future work, verify the
service family before trusting a standard battery value and distinguish compiler
coverage from app-hosted bridge tests and physical delivery. The existing native
README already documents those separate checks; no new skill or guidance change
is proposed.
