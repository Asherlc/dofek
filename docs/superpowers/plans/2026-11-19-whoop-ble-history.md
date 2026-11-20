# WHOOP BLE history resumption implementation plan

> Implement in order with the Paseo Implementer profile. Review test failure evidence, the diff, and validation at each boundary.

**Goal** is to fill Bluetooth gaps using strap history while allowing WHOOP to remain the sync client by default.

## Approved design

Dofek saves replayed samples on either mode using its existing native outbox. Coexistence is the default and leaves history requests, acknowledgments, and aborts to WHOOP. A user can opt in to Dofek-managed history for a particular strap on the iPhone. iOS reports peripherals connected to the system without identifying the connecting app. Unsolicited history is a reason to yield for the current connection. Silence never enables managed history. Managed history assumes the user has removed other clients' access to the strap. The iPhone-only control was approved because it changes which app manages that phone's Bluetooth offload. [Apple Core Bluetooth](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/retrieveconnectedperipherals%28withservices%3A%29).

Use the captured eight-byte-header protocol and reuse the parser, serialized BLE queue, and synchronous SQLite outbox. Acknowledgment may advance the strap's retention boundary. Send it only when the app owns the current offload and has retained every historical sensor record in the chunk or applied the existing account erasure cutoff to it. Reject ambiguous or incomplete chunks. See the [protocol evidence](../../whoop-ble-protocol.md#historical-offload-checkpoint) and the [WHOOP 5/MG transport research](https://github.com/ryanbr/noop/blob/2a1de7609843b095505274ad6fc811757210be80/docs/PROTOCOL_TRANSPORT.md#history-sequencing-and-storage-ownership).

## Task 1. Test and implement the native offload session

- [x] Add `WhoopBleHistoryOffloadTests.swift` using the existing ATT fixture. Check that `0x22` then `0x16` use `00`, that the range pending response alone does not start history, and that every `0x17` body is `01` plus the captured END token. Verify fragments with the existing parser. Verify no commands by default, unsolicited history fencing, sequence mismatch, non-success responses, missing or malformed packets, unretained sensor frames, disconnect reset, duplicate END, and empty completion. Run the targeted tests before adding the implementation and record the failure.
- [x] Share the existing frame builder and sequence for all commands. Preserve the existing activation command body. Let the offload session send a command and get back its originating sequence, receive command responses, process frames after persistence, and reset on a new connection. Use the captured `0x24` reply and its command, origin sequence and result. Accept ordinary `0x31` START, END and COMPLETE on the data path. Confirm each chunk's count using payload offsets 9–12 and echo its eight-byte token at offsets 13–20. In the captured chunks, the count covered `0x2F` history records, `0x30` events and `0x32` console frames. Pass live data through the existing pipeline without counting it. Stop the local attempt on ambiguous, unretained or incomplete history. The all-`FF` empty token must never receive a trim acknowledgment.
- [x] Run `swift test` in `packages/mobile/modules/whoop-ble` and review the diff. Capture the actual test output for review.

## Task 2. Connect native capture and the per-strap setting

- [x] Add tests of default shared behavior, device-scoped setting persistence and erasure, enable confirmation and immediate disable, and the native acknowledgment boundary. Use the real outbox in storage tests. Check that the settings bridge has a safe default on older app builds and that the active setting is applied to the correct device.
- [x] Add the setting to the existing native outbox metadata, scoped to its account binding and removed by the existing purge. Expose it through the device summary and one native setter. Present it in the iOS Bluetooth device details for the identified strap. Require the user to confirm WHOOP no longer uses the strap before enabling. Extend the existing route tests and story where available. An enable applies to the next Bluetooth session. Disabling immediately stops future history writes.
- [x] Integrate the session on the existing BLE queue. Start once when a supported format-1 strap is ready and the stream is started or restored. Reset before connection-specific work on reconnect. Suspend during capture failure, explicit disconnect, upload reconfiguration and account cleanup. Apply history frames only after the existing notification-level commit returns. Track malformed parser drops and withhold ACK for incomplete samples or unknown history variants. Gate the initial release to history layouts already supported by the native and server capture path. Keep passive ingestion and live data operating if managed history cannot proceed.
- [x] Re-run targeted Swift, iOS bridge and mobile tests. Document the setting, support limits and hardware validation boundary in the canonical WHOOP BLE references.

## Task 3. Review and verify

- [x] Review the full branch against packet evidence, storage durability, device and account isolation, and the approved behavior. Check `pnpm lint`, `pnpm --recursive --include-workspace-root --if-present typecheck`, relevant non-interactive mobile tests, Swift tests and the native bridge suite. Exercise positive acknowledgments against a physical strap only when other clients are excluded and sample retention has been authorized. Report any unavailable physical verification.
- [ ] Commit verified changes and push to the current branch after each commit. Use the existing repository signing configuration.
