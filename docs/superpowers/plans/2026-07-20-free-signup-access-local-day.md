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

The seven-day date interval is `[localSignupDate, localSignupDate + 7 days)`: it
includes the local signup date and the next six local dates. For example,
`2026-07-21T01:30:00Z` in `America/Los_Angeles` has local signup date
`2026-07-20` and permits dates `2026-07-20` through `2026-07-26`; the exclusive
end is `2026-07-27`. Conversely, `2026-07-20T15:30:00Z` in `Asia/Tokyo` has
local signup date `2026-07-21` and permits dates `2026-07-21` through
`2026-07-27`; the exclusive end is `2026-07-28`.

## Test-first plan

1. Add a failing entitlement test for a user in `America/Los_Angeles` created at `2026-07-21T01:30:00Z`, asserting the exact `[2026-07-20, 2026-07-27)` date interval.
2. Add the inverse `Asia/Tokyo` case at `2026-07-20T15:30:00Z`, asserting the exact `[2026-07-21, 2026-07-28)` date interval.
3. Add an `America/Los_Angeles` case created at `2026-03-08T07:30:00Z`, immediately before the spring daylight-saving transition, and assert `[2026-03-07, 2026-03-14)`. This interval crosses the transition while still covering seven local calendar dates.
4. Thread the profile's validated IANA timezone through the billing repository/query input and every `resolveAccessWindow()` call, then derive the seven-day date window in that timezone. Advance seven local calendar dates; never compute the exclusive end by adding a fixed 168 hours. Invalid timezone updates remain rejected at the profile boundary; legacy profiles with no timezone use UTC explicitly.
5. Add contract tests for every access-window call site, the missing-timezone UTC fallback, and invalid-timezone rejection without changing paid-access behavior.
6. Re-run the focused entitlement/router tests and `pnpm e2e:web:run`; the dashboard steps assertion should pass without altering the E2E fixture dates.

## Acceptance criteria

- A free user's access window is the half-open interval `[localSignupDate, localSignupDate + 7 days)`, covering exactly the signup date and six subsequent local dates.
- The exclusive end advances by seven local calendar dates and remains correct across daylight-saving transitions.
- The current local day's daily metrics are visible immediately after signup in timezones west and east of UTC.
- Paid access windows are unchanged.
- The dashboard E2E suite displays the seeded 9,200 steps and passes.
