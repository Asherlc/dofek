# Oura Bluetooth npm package implementation plan

The [approved design](../specs/2026-11-19-oura-ble-npm-design.md) defines
the initial public package, its iOS adapter, and the verification needed
for a first release. Use the existing Paseo worktree and the Implementer
profile for bounded implementation. Run behavior checks before and after
each change and review the actual diff before committing.

## 1. Public TypeScript contract

- [ ] Add a testable public package at `packages/oura-ble` with the
  same workspace and compiled export conventions as the existing scoped
  packages. The root entry points provide the portable contract. An
  `@dofek/oura-ble/expo` entry point loads the optional Expo native module.
- [ ] Define `OuraClient` in `packages/oura-ble/src/client.ts` with
  `discoverRings()`, `pairRing(peripheralId, options?)`, `syncRing(ringId)`,
  `readEvents(ringId, options?)`, and `forgetRing(ringId)`. Discovery
  returns opaque peripheral identifiers. Pairing returns a new SDK
  pairing identifier, device information, and any requested measurement
  outcomes. History paging uses a store-local opaque continuation token.
- [ ] First test that importing the portable entry has no native dependency,
  unavailable Expo native modules produce an actionable error on use,
  and the Expo client forwards parameters and native rejections unchanged.
  Then implement the bridge, build declarations, and run the same tests.

## 2. Pairing and event sync

- [ ] Add a native Rust crate under `packages/oura-ble/native` that pins
  `oura-link`, `oura-protocol`, and `oura-store`. Disable the default
  desktop Bluetooth feature. Use UniFFI to bridge write callbacks and
  notification frames to the CoreBluetooth adapter in `ios`. Follow
  the upstream phone client for clock setup and history transfer.
- [ ] First add deterministic replay checks for successful pairing,
  reconnect after an interrupted key installation, unsupported measurement
  requests, and resume after a committed history batch. Use fixtures with
  synthetic serial numbers, keys, and event payloads. Test unknown event
  preservation and page boundaries.
- [ ] Implement the Rust session and iOS Expo module. Keep keys in the
  Keychain and pair against the selected ring. Persist the pending key
  before writing it. A fresh pairing after a reset gets a new store and
  cursor. Validate batch completeness, then atomically commit records and
  the exact millisecond checkpoint in the upstream event schema. Return errors to callers
  and close the owned link on completion or failure. Forgetting a ring
  removes this app's data for the pairing.
- [ ] Re-run replay checks and build device and simulator slices. Verify
  Bluetooth availability, denied authorization, wrong device, concurrent
  callers, and disconnected notification streams through the native
  adapter boundaries.

## 3. Consumer verification and publication

- [ ] Build the XCFramework for ARM64 iOS devices and both simulator
  architectures on macOS. Pack the compiled JavaScript, declarations, Swift
  bridge, Expo module metadata, and XCFramework. Keep build caches and
  capture files outside the tarball.
- [ ] Install the tarball into a clean Expo 58 consumer. Verify imports,
  native autolinking, and device and simulator target compilation. Record
  physical-ring verification separately. If a ring is unavailable,
  document the release as experimental.
- [ ] Include the package in pnpm, Lerna, npm test discovery, and mutation
  configuration. Reuse Dofek's npm workflow and provide the native build
  to it from macOS at the same revision as the packed sources. Verify
  lint, all-workspace type checks, and relevant tests before pushing.
- [ ] Bootstrap the first public version from the verified tarball using
  the npm package owner's session, configure the existing trusted
  publisher, and verify installation from the registry. Keep the first
  publish coordinated with release-list registration. Follow the
  [publishing guide](../../package-publishing.md#adding-another-npm-package).
