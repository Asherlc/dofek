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

## Approved native mutation repair

The user explicitly approved repairing the mutation workflow in this PR after
the hosted job sent WHOOP paths to HealthKit, discovered zero files, and
converted exit 255 into success. Use the existing Muter tool and SwiftPM;
introduce no replacement mutation framework or score threshold.

A TypeScript CLI receives the comparison base, reads the committed PR delta
using Git's `base...HEAD` merge-base comparison, selects changed Swift files,
finds each owning `Package.swift`, and uses
[`swift package describe --type json`](https://github.com/swiftlang/swift-package-manager/blob/main/Sources/Commands/PackageCommands/Describe.swift)
to intersect changes with compiled non-test Swift targets. This respects Expo
bridge exclusions already declared by each package. Skip only an empty
compiled-source intersection. Run Muter from each affected package with
package-relative source paths and absolute JSON report paths. Propagate every
nonzero tool exit, including 255; require a valid positive-work report after a
successful selected-source run. Do not infer benign zero work from a generic
error status: [Muter run command](https://github.com/muter-mutation-testing/muter/blob/16/Sources/muterCore/CLICommands/RunCommand/Run.swift).

Use one canonical `packages/mobile/muter.conf.yml` with package-local relative
symlinks for the seven native modules and watch transfer package. Muter loads
configuration from its working directory and clones that directory to a
sibling with the same depth, preserving these relative links:
[configuration loader](https://github.com/muter-mutation-testing/muter/blob/16/Sources/muterCore/MuterRunSteps/LoadConfiguration.swift),
[clone location](https://github.com/muter-mutation-testing/muter/blob/16/Sources/muterCore/MuterRunSteps/CreateTempDirectoryURL.swift).
Retain `swift test --package-path .` as the package test command and remove
obsolete ignored configuration keys. Muter 16 is the installed and
[latest stable release](https://github.com/muter-mutation-testing/muter/releases/tag/16)
verified for this repair.

Public CLI fixture tests must reproduce multi-package routing, relative paths,
manifest-based test/bridge exclusion, missing prerequisites, and nonzero
Muter/SwiftPM/report failures. Verify the actual runner against real SwiftPM
and Muter on the changed WHOOP source, inspect the resulting report, and retain
its precise mutation results. The workflow must use this runner and upload
all affected-package reports; it must not catch discovery failures as success.
