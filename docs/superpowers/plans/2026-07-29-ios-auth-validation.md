# iOS Authentication Validation TDD Plan

> **For agentic workers:** Write and run each failing test before its production change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make password sign-in and account creation clear, password-manager friendly, and actionable when input is invalid.

**Behavior:** Mobile and web auth forms expose password visibility controls, use the canonical server password limits, advertise the correct current/new password autocomplete purpose, and show field-level validation guidance before sending invalid credentials.

**Scope:** Include shared password-policy validation, the iOS auth form, web parity, colocated tests, auth stories, and an iOS Simulator audit. Keep server authentication behavior and the reset/settings surfaces unchanged.

**Docs:** [React Native `TextInput`](https://reactnative.dev/docs/textinput.html), [Apple text-field guidance](https://developer.apple.com/design/human-interface-guidelines/text-fields), [Apple writing guidance](https://developer.apple.com/design/human-interface-guidelines/writing), and [Apple Password AutoFill rules](https://developer.apple.com/documentation/Security/customizing-password-autofill-rules).

---

## Current Evidence

- `packages/mobile/app/login.tsx` always sets `secureTextEntry`, has no visibility control, and disables submission based only on non-empty strings.
- The mobile password field uses the `password` autocomplete value for sign-in rather than React Native's cross-platform `current-password` value.
- `packages/server/src/auth/password.ts` enforces 8–128 characters, while clients do not share that policy or explain it before registration.
- Auth failures render in a page-level message instead of beside the password field.
- `packages/web/src/routes/login.tsx` has the same reveal and field-level guidance gap, so the repository's dual-platform parity rule applies.

## Test Strategy

- Unit: shared email/password validation boundaries and the server adapter's existing exception behavior.
- UI mobile: current/new password metadata, visibility toggling, registration requirements, invalid email/password errors, and prevention of invalid requests.
- UI web parity: visibility toggling, requirements, inline validation, and prevention of invalid requests.
- Stories: update auth stories with sign-in, account-creation, and validation variants.
- Runtime: build and launch the Release iOS app with XcodeBuildMCP, then exercise sign-in/create-account visibility and validation through native accessibility snapshots.

## File Structure

- Modify: `packages/auth/src/auth.ts` and `packages/auth/src/auth.test.ts` — define and test the canonical client-safe password policy.
- Modify: `packages/server/src/auth/password.ts` and `packages/server/src/auth/password.test.ts` — delegate validation to the shared policy while preserving server error types.
- Modify: `packages/mobile/app/login.tsx`, `login.test.tsx`, and `login.stories.tsx` — implement and cover the iOS form behavior.
- Modify: `packages/web/src/routes/login.tsx` and `-login.test.tsx` — maintain equivalent browser behavior.

## Tasks

### Task 1: Add Failing Shared Policy Tests

- [x] Add exact email/password boundary and guidance tests in `packages/auth/src/auth.test.ts`.
- [x] Add a server test proving the shared policy still surfaces `InvalidPasswordError`.
- [x] Run the focused unit tests (using `pnpm` directly because `rtk` is not installed).
- [x] Confirm the tests fail because the shared helpers do not exist.

### Task 2: Implement the Canonical Policy

- [x] Add the smallest shared validation API that represents the server's existing 8–128 character contract.
- [x] Delegate server validation to it without changing hashing or authentication semantics.
- [x] Run the focused tests and confirm they pass.

### Task 3: Add Failing Mobile Form Tests

- [x] Test visible labels and iOS-compatible autocomplete/password-rule metadata.
- [x] Test show/hide password behavior and accessible control names.
- [x] Test actionable inline email/password errors and invalid-request prevention.
- [x] Run the focused mobile test with `pnpm`.
- [x] Confirm the tests fail for the missing form behavior.

### Task 4: Implement the Mobile Form and Stories

- [x] Implement the smallest form changes that satisfy the mobile tests.
- [x] Keep OAuth/provider errors page-level and password-form errors adjacent to the form.
- [x] Update stories for sign-in, registration requirements, and validation variants.
- [x] Run the focused mobile tests and confirm they pass.

### Task 5: Add Failing Web-Parity Tests and Implement

- [x] Add equivalent reveal, requirements, inline validation, and invalid-request tests.
- [x] Run the focused web route test with `pnpm`.
- [x] Confirm the tests fail before changing the route.
- [x] Implement parity and rerun the focused tests.

### Task 6: Final Verification

- [ ] In Codex cloud, initialize with `SANDBOX=1 mise run cloud:init` and run the
      complete Docker-free verification entrypoint with `mise run test:sandbox`.
- [ ] Outside Codex cloud, run `pnpm lint`.
- [ ] Outside Codex cloud, run `pnpm tsc --noEmit`,
      `(cd packages/server && pnpm tsc --noEmit)`, and
      `(cd packages/web && pnpm tsc --noEmit)`.
- [ ] Outside Codex cloud, run `pnpm test:mobile`, `pnpm test:unit`, and
      `pnpm test`.
- [ ] Use XcodeBuildMCP for a signed Release Simulator build, launch, native UI snapshot, and screenshot.
- [ ] Commit and push each meaningful passing chunk, then open a PR with `Fixes #2192`.
