# Authentication Legal Navigation TDD Plan

**Goal:** Make account creation disclose Dofek's legal terms on web and iOS, while keeping a clear sign-in path and giving the responsive web login a stable route back home.

**Behavior:** Registration shows links to the Terms of Service and Privacy Policy on both clients; iOS opens the selected policy on the configured Dofek server; signed-out web users can read both policies; registration retains a named sign-in action; and every web auth mode links back to the Dofek home page.

**Scope:** Reuse the existing `/terms` and `/privacy` web documents and the mobile app's configured `serverUrl`. Do not create native policy copies, introduce new legal text, change authentication requests, or add a native back action when the native login screen is the root unauthenticated route.

**Docs:** [Issue #2101](https://github.com/Asherlc/dofek/issues/2101)

---

## Current Evidence

- `packages/web/src/routes/login.tsx` and `packages/mobile/app/login.tsx` show no Terms of Service or Privacy Policy context in registration mode.
- Both clients already keep “Sign in” available in the account-creation mode selector.
- The web app already serves canonical `/terms` and `/privacy` pages, and the mobile auth context exposes the configured server origin used for the current Dofek instance.
- `packages/web/src/routes/__root.tsx` allows anonymous `/privacy` visits but omits `/terms`, so an unauthenticated Terms link currently redirects to login.
- The responsive web login has no home link or other explicit navigation away from authentication.

## Test Strategy

- Web route: prove registration renders named Terms, Privacy, and existing-account links with canonical same-origin destinations, and prove every auth mode exposes the Dofek home link.
- Web auth gate: prove signed-out users can render both legal routes without being redirected to login.
- Mobile route: prove registration renders named legal actions and that each opens the matching path on the configured server; prove the existing sign-in action remains available.
- Storybook: verify the existing mobile login story still compiles; the registration
  state remains covered through the route's public mode selector rather than a
  production-only story control.
- Runtime: audit the responsive web flow and, if local signing prerequisites are available, the software-only iOS registration flow.

## File Structure

- Create: `docs/superpowers/plans/2026-07-29-auth-legal-navigation.md` - record the confirmed behavior and validation.
- Modify: `packages/web/src/routes/login.tsx` - add the stable home route and registration legal context.
- Modify: `packages/web/src/routes/-login.test.tsx` - cover home, legal, and existing-account navigation.
- Modify: `packages/web/src/routes/__root.tsx` - make the existing Terms page public.
- Modify: `packages/web/src/routes/__root.test.tsx` - cover anonymous legal-route access.
- Modify: `packages/mobile/app/login.tsx` - add instance-relative legal actions in registration mode.
- Modify: `packages/mobile/app/login.test.tsx` - cover legal destinations and the existing-account path.

## Tasks

### Task 1: Add Failing Web Tests

- [x] Assert account creation exposes Terms of Service, Privacy Policy, and sign-in navigation.
- [x] Assert the auth page exposes a stable Dofek home link in login, registration, and reset modes.
- [x] Assert anonymous Terms and Privacy routes render without a login redirect.
- [x] Run `pnpm vitest run --project unit packages/web/src/routes/-login.test.tsx packages/web/src/routes/__root.test.tsx`.
- [x] Confirm failures identify the missing links and `/terms` public-route gap.

### Task 2: Add Failing Mobile Tests

- [x] Assert registration exposes Terms of Service, Privacy Policy, and sign-in actions.
- [x] Assert each legal action opens the corresponding path on the configured instance origin.
- [x] Run `pnpm vitest run --project mobile packages/mobile/app/login.test.tsx`.
- [x] Confirm failures identify the missing registration context and link behavior.

### Task 3: Implement the Minimal Cross-Client Fix

- [x] Add same-origin legal and home links to the web auth route.
- [x] Include `/terms` in the web public-route contract.
- [x] Add configured-instance legal actions to native registration.
- [x] Re-run the focused web and mobile tests and confirm they pass.

### Task 4: Final Verification

- [x] Run `pnpm lint`.
- [x] Run root, server, web, and mobile TypeScript checks.
- [x] Run `pnpm test`.
- [x] Build the web app and both Storybooks.
- [x] Audit responsive web navigation and the signed iOS Simulator registration flow.
- [ ] Commit, push, open a PR with `Fixes #2101`, link it from the issue, and monitor all checks and review feedback through merge.
