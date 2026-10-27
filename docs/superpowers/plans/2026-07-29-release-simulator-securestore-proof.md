# Release Simulator SecureStore Proof TDD Plan

**Goal:** Make the signed Release-simulator audit workflow prove that the built
app can persist and restore a real session through SecureStore before the
artifact is called audit-ready.

**Behavior:** An auditor creates a fresh account in the signed Release app,
hard-stops the app, relaunches the same installed artifact, and observes an
authenticated screen restored from the persisted session without SecureStore or
keychain errors.

**Scope:** Update the mobile audit runbook and validate it against a real
Release-simulator artifact. Do not add an audit-only product route, test-only
runtime branch, duplicate UI automation framework, static-config test, or
generated Xcode source.

**Docs:** [Issue #2200](https://github.com/Asherlc/dofek/issues/2200),
[Expo SecureStore data persistence](https://docs.expo.dev/versions/latest/sdk/securestore/#data-persistence),
[Apple keychain access groups](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps),
[local production builds](https://docs.expo.dev/guides/local-app-production/),
and [XcodeBuildMCP setup](https://www.xcodebuildmcp.com/#get-started).

---

## Current Evidence

- The issue records a Release-simulator artifact that built successfully but
  failed SecureStore at runtime with a missing-entitlement error.
- The current `packages/mobile/README.md` build command uses local ad-hoc
  signing, then asks the auditor to install, launch, and inspect the UI. It does
  not require a SecureStore write, process termination, or cold-start read.
  Therefore its current acceptance condition can pass without proving the
  reported failure is absent.
- `packages/mobile/lib/auth.ts` is the smallest observable production path:
  password registration calls `saveSessionToken()`, which writes through
  `writeSecureStoreItem()`. After process termination,
  `AuthProvider.retryBootstrap()` calls `getSessionToken()` and
  `fetchCurrentUser()`. An authenticated screen after relaunch proves the
  persisted value was readable in a new process.
- The only other production consumer,
  `health-kit-food-writeback.ts`, persists a synchronization ledger but has no
  direct UI acceptance signal and requires unrelated health-data setup.
- Repository search found no Detox, Maestro, Appium, or XCUITest mobile
  end-to-end harness. The repository already pins XcodeBuildMCP for simulator
  lifecycle control, native accessibility snapshots, screenshots, and logs.
- Static entitlement inspection is useful supporting evidence, but Apple
  documents that final entitlements are applied during signing and the
  reported defect is a runtime keychain failure. Only the production
  write/terminate/read flow is sufficient acceptance evidence. See
  [Apple's entitlement documentation](https://developer.apple.com/documentation/bundleresources/entitlements).

## Test Strategy

- Unit: none; this is a documentation-only change and repository guidance
  forbids tests for static configuration or documentation.
- Runtime integration: execute the production password-registration and
  cold-start session-bootstrap flow in the ad-hoc-signed Release app against an
  isolated local server account.
- UI/mobile/web parity: mobile-only audit tooling; no user-facing product
  behavior changes, so web parity is not applicable.

## File Structure

- Create:
  `docs/superpowers/plans/2026-07-29-release-simulator-securestore-proof.md`
  — executable test-first plan and evidence.
- Modify: `packages/mobile/README.md` — mandatory runtime acceptance sequence
  and audit-ready criteria.

## Tasks

### Task 1: Preserve the Failing Acceptance Condition

**Files:**

- Inspect: `packages/mobile/README.md`
- Inspect: `packages/mobile/lib/auth.ts`
- Inspect: `packages/mobile/lib/auth-context.tsx`

- [ ] Record that the existing workflow stops after build/install/launch and
  can declare success without a write, hard process termination, or cold-start
  read.
- [ ] Generate `ios/` from checked-in Expo config with
  `rtk env EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:3100 EXPO_PUBLIC_SENTRY_DSN=https://public-key@sentry.example/project-id pnpm --dir packages/mobile prebuild`.
- [ ] Build the current Release app with the exact documented manual ad-hoc
  signing settings and an explicit simulator destination.
- [ ] Confirm that compilation, signature verification, the generated
  `Dofek.app-Simulated.xcent`, and the executable's
  `__TEXT,__entitlements` section are supporting evidence only and do not
  satisfy the runtime acceptance condition. An empty
  `codesign -d --entitlements :- <app>` dictionary is expected when Xcode
  reports `ENTITLEMENTS_DESTINATION=__entitlements` for the Simulator build.

### Task 2: Document the Minimum Production SecureStore Proof

**Files:**

- Modify: `packages/mobile/README.md`

- [ ] Require a clean simulator state and fresh isolated account so an old
  keychain item cannot create a false pass. Expo documents that iOS SecureStore
  data can persist across uninstall/reinstall for the same bundle identifier;
  see
  [Expo's SecureStore data-persistence documentation](https://docs.expo.dev/versions/latest/sdk/securestore/#data-persistence).
- [ ] Require XcodeBuildMCP to install and launch the exact Release artifact.
- [ ] Require a native accessibility snapshot of the login screen before the
  write.
- [ ] Require account creation through the existing password-registration UI
  and a native accessibility snapshot of the resulting authenticated
  onboarding screen.
- [ ] Require a hard app stop, relaunch of the same installed artifact, and a
  second native accessibility snapshot showing an authenticated screen instead
  of login.
- [ ] Require app and server logs with no SecureStore, keychain, session
  bootstrap, or missing-entitlement error.
- [ ] State explicitly that a build, process launch, or static entitlement dump
  alone is not audit-ready.

### Task 3: Validate the Runbook Against a Real Release Artifact

- [ ] Run `rtk pnpm lint`.
- [ ] Skip unit tests because the diff is Markdown-only and static
  documentation tests are prohibited.
- [ ] Use XcodeBuildMCP to install and launch
  `packages/mobile/.context/ReleaseAuditDerivedData/Build/Products/Release-iphonesimulator/Dofek.app`.
- [ ] Capture the pre-registration native snapshot, authenticated
  post-registration snapshot, hard-stop/relaunch authenticated snapshot, app
  logs, server logs, and simulated-entitlement inspection.
- [ ] Confirm the tracked worktree contains no generated `ios/` or audit
  residue.
- [ ] Commit and push the documentation and plan, link the PR with
  `Fixes #2200`, and monitor required checks and reviews through merge.
