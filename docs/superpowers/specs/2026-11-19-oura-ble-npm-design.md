# Oura Bluetooth npm package

Approved November 19, 2026.

## Scope

Publish `@dofek/oura-ble` on npm so apps can pair with an Oura Ring and
retrieve its recorded data over Bluetooth. Ship a common TypeScript API and
an iOS adapter for Expo and React Native apps configured with Expo modules.
The package can be installed and tested outside the Dofek workspace. Host apps
own their UI, account association, uploads, and derived metrics.

## Pairing and sync

The caller discovers nearby rings, selects one, and pairs it from the iPhone.
The ring must be new or factory-reset. CoreBluetooth handles the Bluetooth
bond. The adapter creates an app key and stores it in the iOS Keychain. Keep
the pending key available across interrupted pairing so the user can retry
if the ring accepted it before the connection dropped. Confirm authentication
before reporting pairing success. Upstream demonstrated phone-only pairing
and sync on a Gen 3 Horizon. [Upstream pairing test](https://github.com/Th0rgal/open_health/pull/3)

For an already-paired ring, the setup instructions direct the user to sync
their existing data with Oura before choosing whether to reset the ring.
Resetting erases the ring's stored events and credentials. A reset-free
handoff from the official iOS app remains unverified. Static inspection of
Android 7.15.0 (260521094) with JADX found a backup step during sign-out and a
separate Remove action that skips factory reset. Those paths supplied no
evidence of a third-party pairing grant. [Oura reset guide](https://support.ouraring.com/hc/en-us/articles/360025446854-Factory-Reset-an-Oura-Product) · [Oura phone-transfer guide](https://support.ouraring.com/hc/en-us/articles/360025592293-Transfer-Your-Oura-Data-to-a-New-Phone)

The first release exposes discovery, pairing, foreground history sync, and
paged access to recorded events. The SDK uses the upstream event schema and
body decoders in the host app's private storage. It validates each batch and
commits the records and inclusive millisecond cursor in the same transaction.
After an interruption the SDK resumes at the committed cursor. A new pairing
after a confirmed reset starts a separate sync history for the same physical
ring. The host can continue reading the old events until it removes that pairing.
[Upstream batch storage](https://github.com/Th0rgal/open_oura/blob/4f7957d3304c4084f0e1e703f3d84606bf10b781/crates/oura-store/src/storage.rs)

Events carry ring identity, event type, ring-relative timestamp, capture
time, decoded fields when available, and the raw event body. Return clock
anchor events with the other records so consumers can resolve observation
times. Capture time identifies receipt. Sync follows upstream's clock and
sleep-processing flow. Hosts can explicitly request supported measurement
settings during setup, since a freshly keyed ring may have sensors disabled.
Report which settings the ring accepted separately from pairing success.
[Upstream measurement settings](https://github.com/Th0rgal/open_oura/blob/main/crates/README.md#commands) · [Upstream clock and sleep flow](https://github.com/Th0rgal/open_health/pull/3)

## Implementation choice

Reuse `oura-protocol` and `oura-link` at a pinned MIT-licensed
`open_oura` revision. Use the existing transport interface and the upstream
iOS binding as the starting point for the CoreBluetooth adapter. A small
native bridge exposes the operations needed by the public API. The common
TypeScript entry point exposes types and the client contract. The iOS entry
point supplies the implementation and can be imported independently of
Dofek's app. A Node or Android adapter can use the same contract and Rust
core. [Upstream license](https://github.com/Th0rgal/open_oura/blob/main/LICENSE) · [Transport interface](https://github.com/Th0rgal/open_oura/blob/main/crates/oura-link/src/transport.rs) · [Existing iOS build](https://github.com/Th0rgal/open_health/blob/main/apps/ios/build-xcframework.sh)

A TypeScript protocol port would share the same JavaScript implementation
across hosts with compatible Bluetooth adapters. It would require maintaining
a second pairing, sync, and decoder implementation. Reusing the Rust driver
keeps that work upstream. The iOS release includes a built XCFramework for the
device and simulator so consumers only need their usual iOS build tools.
[Expo autolinking](https://docs.expo.dev/modules/autolinking/)

## Work and acceptance

1. Establish the public client types and native boundary. Use fixture-driven
   tests to verify pairing outcome, event transfer, resume, and actionable
   failures. Keep the public package independent of the Dofek app.
2. Build the iOS adapter and run the package checks. Verify the npm tarball
   in a clean consumer project, including TypeScript import, CocoaPods
   autolinking, and builds for ARM64 devices and Apple silicon simulators.
   Use Dofek's current Expo 58 and React Native 0.88 stack as the initial
   compatibility baseline. Document the iOS deployment target verified by
   the clean consumer build.
3. Build the iOS artifact and npm tarball from the same source revision.
   After fixture replay and consumer builds pass, publish the first version
   as experimental if a physical ring remains unavailable. Document the
   upstream hardware evidence and the packaged SDK's own verification.
   Verify a fresh registry installation. Coordinate the initial npm owner
   publish, trusted-publisher setup, and registration in Dofek's existing
   pnpm and Lerna workflow so automatic releases remain usable.
   [Dofek package publishing guide](../../package-publishing.md)
