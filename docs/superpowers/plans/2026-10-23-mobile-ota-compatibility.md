# Mobile OTA compatibility implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this approved implementation.

**Goal:** Restore compatible OTA delivery to runtime 1.12 and automatically separate future native interfaces.

**Architecture / approved design:** Republish the stored pre-notification iOS bundle for runtime 1.12 as an operator action. Keep runtime 1.13 deliveries intact. Adopt Expo's fingerprint runtime policy for subsequent native builds and OTA publications, with explicit Watch-source coverage. The existing publisher resolves fingerprint policies through expo-updates; no server replacement or application fallback is needed.

**Tech stack:** Expo Updates, Expo Fingerprint, pinned EOAS publisher, existing self-hosted OTA server.

**Sources:** [Expo runtime policies](https://docs.expo.dev/eas-update/runtime-versions/), [fingerprint configuration](https://docs.expo.dev/versions/latest/sdk/fingerprint/), [pinned publisher runtime resolution](https://github.com/mercuretechnologies/xprem/blob/v2.3.22/apps/eoas/src/lib/runtimeVersion.ts), [server republish handler](https://github.com/mercuretechnologies/xprem/blob/v2.3.16/internal/handlers/republish_handler.go).

## Constraints and review focus

- No branch switching, compatibility aliases, new secrets, dependencies, or startup wait changes.
- Recovery must affect only iOS runtime 1.12 and preserve the 1.13 manifest.
- Review rollback persisted-state safety before publication.
- Native bridge and Watch-source changes must alter the fingerprint; ordinary JavaScript edits must preserve it.
- Native prebuild and OTA publication must resolve the same managed-workflow runtime.
- Configuration changes use schema/build validation and executable tool probes, rather than unit tests of static configuration.

### Task 1: Recover existing installations

- [x] Inspect production update history and compare the pre-notification source with the broken release for persisted-state changes.
- [x] Attempt republish of stored update 1792734716822, commit 60ff74754a3b4ad544110a9b43266b8abf4cafc9, to main/iOS/1.12 using the existing server API. The request stalled; with explicit user approval, publish signed rollback-to-embedded update 1792800833307 instead. No repeated POST or timeout/retry change.
- [x] Verify signed 1.12 rollback and already-embedded directives and unchanged 1.13 manifest; record physical-device verification limits in the incident baseline.

### Task 2: Automate native compatibility

**Files:** packages/mobile/app.json, packages/mobile/fingerprint.config.js, packages/mobile/.fingerprintignore, .github/workflows/deploy-ios.yml, .github/workflows/mobile-preview-ota.yml, packages/mobile/README.md.

- [x] Change runtimeVersion to Expo's fingerprint policy; explicitly include targets in fingerprint extraSources. Exclude generated Watch app-icon output; its source icon is fingerprinted.
- [x] Include fingerprint configuration in native deployment change detection.
- [x] Review checkpoint: include certificate, custom podspec, and workspace patches omitted by Expo's default source discovery; include all current fingerprint inputs in native triggers and align preview publishing with preview build configuration.
- [x] Run Expo runtime resolution, mutate temporary native/Watch/JavaScript fixture inputs, and verify expected fingerprint changes or stability; restore all probe edits.
- [x] Validate resolved prebuild runtime and export/publication tooling compatibility. Native build-resource generation matches publisher resolution, and icon regeneration preserves the hash.
- [x] Document staging on already-shipped binaries, recovery of old runtimes, fingerprint rollout, and safe application of downloaded updates.

### Task 3: Verify and deliver

- [x] Review the complete diff and documentation citations. Independent review found four native-input/preview gaps; all were addressed and verified with executable Expo probes.
- [x] Run appropriate configuration/build validation, lint, typechecks, and unit/mobile tests; report exact blockers. All passed after initializing the required local ClickHouse environment.
- [ ] Update incident evidence, commit, push, open a PR, and monitor required checks.
