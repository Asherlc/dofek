# iOS Physical-Device Release Audit TDD Plan

**Goal:** Establish a repeatable physical-device release gate for Dofek's
hardware-dependent iOS and watchOS behavior.

**Behavior:** Every iOS release candidate has an auditable TestFlight build
record, a capability-based device matrix, a synthetic-only account/device
workflow, and explicit pass or blocker evidence.

**Scope:** Add the current runbook and link it from the mobile and documentation
indexes. Do not automate App Store Connect, provision accounts, change runtime
behavior, or add a volatile list of Apple device models.

**Docs:** [Issue #2196](https://github.com/Asherlc/dofek/issues/2196),
[mobile architecture](../../../packages/mobile/README.md), and
[TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview).

---

## Current Evidence

- The iOS release workflow uploads signed Release archives to TestFlight, but
  the repository has no physical-device release gate.
- Apple explicitly requires a device for
  [HealthKit observer background delivery](https://developer.apple.com/documentation/healthkit/executing-observer-queries)
  and a physical iPhone and Watch for its
  [Watch Connectivity transfer sample](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity).
- The remaining matrix exercises the real hardware boundaries documented by
  [Core Bluetooth](https://developer.apple.com/documentation/corebluetooth),
  [Core Motion](https://developer.apple.com/documentation/coremotion), and
  [AVFoundation camera authorization](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media).
- Existing module docs identify individual physical-device boundaries, but
  release evidence is not gathered in one matrix.
- `pnpm seed` is a development/review-database tool with fixed identifiers and
  destructive cleanup. It is not a safe way to populate a production audit
  account.

## Test Strategy

- Unit: none; no executable behavior changes.
- Integration: none; static Markdown must not receive dedicated content tests.
- Physical iOS/watchOS: define the exact TestFlight release-candidate matrix
  and evidence requirements in the runbook.
- Documentation validation: inspect links and repository paths, run cspell on
  the new and materially changed Markdown, and run the normal static-policy
  lint gate.

## File Structure

- Create: `docs/ios-physical-device-release-audit.md` - current release gate,
  synthetic-account safety rules, matrix, and evidence template.
- Modify: `docs/README.md` - index the current runbook.
- Modify: `packages/mobile/README.md` - distinguish the Simulator audit from
  the required physical-device release gate.

## Tasks

### Task 1: Define the release gate

- [x] Inspect the TestFlight workflow, deployment targets, native module
  boundaries, and existing simulator audit.
- [x] Confirm Apple guidance for TestFlight, HealthKit background delivery,
  Core Bluetooth, Core Motion, Watch Connectivity, background tasks, and
  camera authorization.
- [x] Define capability-based compatibility and current-OS lanes without
  hard-coding a volatile model list.

### Task 2: Define the synthetic-account workflow

- [x] Separate the TestFlight tester identity, Dofek audit account, and
  synthetic-only audit device.
- [x] Prohibit personal provider credentials and production use of the local
  deterministic database seeder.
- [x] Define data preparation and evidence handling without real health data,
  secrets, device identifiers, or account credentials.

### Task 3: Publish and verify

- [x] Add the runbook and index links.
- [x] Run `pnpm exec cspell --no-progress` on the new and materially changed
  Markdown.
- [x] Run `pnpm lint:sandbox`.
- [x] Attempt `pnpm lint`; record that the unrelated analytics SQL phase could
  not connect to local ClickHouse, and the workspace service could not start
  because Docker exhausted its predefined network address pools.
- [x] Review the final diff for current paths, cited platform claims, and
  documentation-only scope.
