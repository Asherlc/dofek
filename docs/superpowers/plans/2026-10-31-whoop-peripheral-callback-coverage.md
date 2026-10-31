# WHOOP peripheral callback coverage

The owner approved expanding PR 3179 with a CoreBluetooth interface refactor and automated callback coverage, following [the review](https://github.com/Asherlc/dofek/pull/3179#pullrequestreview-5721735543).

## Design and constraints

Use an internal class-bound peripheral connection interface for the existing identity, state, delegate, discovery, notification and write operations. A production adapter retains the native peripheral and central manager and forwards connect/cancel operations. The manager owns one interface instance; CoreBluetooth callbacks enter the same handlers through adapters. Preserve the native peripheral object identity used for notification tracking across callback adapters. Apple documents [peripheral operations](https://developer.apple.com/documentation/corebluetooth/cbperipheral) and [asynchronous cancellation](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/cancelperipheralconnection(_:)).

Keep the public Swift/Expo APIs, reconnect policy, queue access, timeouts and hardware requirements unchanged. [Nordic's mock library](https://github.com/nordicsemi/IOS-CoreBluetooth-Mock) replaces the wider CoreBluetooth API; this correction needs only the existing peripheral operations, so add no dependency.

## Execution and review checkpoints

1. Write callback-handler regressions first using a test peripheral: automatic failure retains ownership until matching disconnect and restores pending reconnect; stale disconnect/failure does not affect the current peripheral; explicit disconnect overrides recovery; timeout invokes the actual peripheral cancellation wrapper. Observe the old boundary failing to accept these tests, then implement the interface and native adapter. Interfaces: `WhoopBlePeripheralConnection` and the existing connection-manager handler names.
2. Verify full native tests and strict SwiftLint. Temporarily clear the retained reference, remove the stale guard, and omit cancellation/reconnect independently; each corresponding regression must fail before restoring the correct source. Cover notification identity across distinct adapters and command forwarding through existing consumers. Review the Expo delegate signature changes and run applicable types/lint/unit tests.
3. Obtain one fresh-context review, fix important findings with RED/GREEN evidence, commit and push automatically, update the review response and PR description, and monitor final-head CI to completion. Leave the PR unmerged.

Review focus: repeated cancellation, stale UUIDs, intentional disconnect, underlying notification identity, and readiness/write forwarding. Native radio behavior remains a physical-device check; automated callback policy tests do not establish radio correctness.
