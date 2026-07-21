# Free signup access window hides the current local day west of UTC

## Summary

The seven-day free signup window is anchored to the UTC calendar date of `user_profile.created_at`. For users west of UTC who sign up after UTC midnight, the access window starts on tomorrow's local date and filters all health data from their current local day.

## Runtime evidence

- The isolated E2E stack ran in UTC on 2026-07-21 while Cypress and the web app ran in America/Los_Angeles on 2026-07-20.
- Cypress created the test user and seeded seven rows dated 2026-07-14 through 2026-07-20, ending at 9,200 steps.
- `fitness.v_daily_metrics` returned all seven rows, including 9,200 steps on 2026-07-20.
- `dailyMetrics.trends({ days: 30, endDate: "2026-07-20" })` returned `latest_steps: null` and `latest_date: null`.
- The dashboard rendered `Steps—`, and `cypress/e2e/dashboard.cy.ts` failed after both attempts expecting `9,200`.
- `resolveAccessWindow()` truncates `userCreatedAt` to UTC midnight and does not accept the user's timezone, while repository date predicates compare local health-data dates to that UTC-derived date.

## Expected behavior

A newly registered user can view health data from their current local signup day, regardless of the UTC date at signup time.

## Test-first plan

1. Add a failing entitlement test for a user in `America/Los_Angeles` created after UTC midnight, asserting that the limited window starts on the user's local calendar date.
2. Add the inverse boundary case for a timezone east of UTC to prevent shifting the window in the other direction.
3. Thread the profile's validated IANA timezone through the billing repository/query input and every `resolveAccessWindow()` call, then derive the seven-day date window in that timezone. Invalid timezone updates remain rejected at the profile boundary; legacy profiles with no timezone use UTC explicitly.
4. Add contract tests for every access-window call site, the missing-timezone UTC fallback, and invalid-timezone rejection without changing paid-access behavior.
5. Re-run the focused entitlement/router tests and `pnpm e2e:web:run`; the dashboard steps assertion should pass without altering the E2E fixture dates.

## Acceptance criteria

- A free user's access window starts on the calendar date at their configured timezone, not the UTC calendar date.
- The current local day's daily metrics are visible immediately after signup in timezones west and east of UTC.
- Paid access windows are unchanged.
- The dashboard E2E suite displays the seeded 9,200 steps and passes.
