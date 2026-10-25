# Preserve pending WHOOP automatic reconnects

The user approved this native fix after the [incident evidence](../../incidents/2026-10-24-whoop-connection-evidence.md#foreground-replay-confirms-the-recovery-failure)
proved that the application cancelled an automatic Bluetooth connection after
ten seconds and disabled subsequent automatic recovery.

## Approved approach

Keep automatic Core Bluetooth connection requests pending until connection,
explicit cancellation, or a real connection failure. Start the existing
bounded service-discovery/notification-subscription handshake once Bluetooth
connects. Preserve bounded explicit connection calls and foreground discovery
of an already-pending peripheral. Handle restored pending and connected
peripherals according to their actual connection state.

Apple documents that [connection attempts do not time out](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/connect(_:options:))
and that [restored peripherals can be connected or pending](https://developer.apple.com/documentation/corebluetooth/cbcentralmanagerrestoredstateperipheralskey).
The scope is the existing native connection manager, not a new retry framework.
Preserve the ten-second timeout value, alert policy, public Swift/Expo APIs,
sample buffering, explicit cancellation and upload behavior. No dependencies
or configuration are added. This is iOS-specific Core Bluetooth behavior;
there is no corresponding web implementation.

## Alternatives and trade-offs

Increasing the timeout delays the same cancellation and does not address the
confirmed recovery failure. A new retry loop duplicates Core Bluetooth's
pending connection mechanism. The approved approach follows the existing
native lifecycle and retains bounded setup after the radio connection exists.
An automatic request may remain pending while the strap is unavailable; the
existing delayed disconnect notification still reports lost collection.

## Proof and release boundary

Native regressions must exercise passive pending connection survival,
bounded explicit connection requests, discovery/subscription timeouts after
connection, stale timer ownership, and intentional cancellation. Review the
concrete Core Bluetooth discovery/retry, restoration and callback ownership
paths, then verify them on hardware. Existing upload
timeout fallback tests must pass. Run Swift tests, strict SwiftLint, repository
lint and required TypeScript checks, then obtain independent code review.
Native changes need a [new iOS build](https://docs.expo.dev/workflow/customizing/).
Unit tests and Simulator compilation do not establish sustained collection on
physical hardware; verify reconnect and fresh capture there after release.

## Required CI scope correction

Validation of the native fix exposed a reproducible CI detector gap: the
workspace graph assigns changed WHOOP files to the nested module package, but
does not propagate that package to the parent mobile app. Expo also discovers
[local native modules](https://docs.expo.dev/modules/autolinking/#nativemodulesdir)
outside manifest dependency traversal. Treat non-documentation paths under
`packages/mobile/` as mobile changes while retaining shared-workspace impact
detection and the existing documentation-only behavior. Add a failing public
detector regression before the smallest classification fix. This correction
is needed to run the existing native CI checks for this change; it does not
alter the approved Bluetooth implementation or add package dependencies.
