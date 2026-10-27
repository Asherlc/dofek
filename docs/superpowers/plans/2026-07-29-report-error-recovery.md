# Report Error Recovery Implementation Plan

Issue: [#2170](https://github.com/Asherlc/dofek/issues/2170)

## Goal

Keep the last weekly or monthly report visible during refresh failures, describe
the exact server-owned report window and accepted data prerequisites, and give
web and iOS users explicit retry and processing-alert review actions.

## Server contract

1. Add focused tests for deterministic weekly and monthly inclusive ranges,
   server-authored empty guidance, and range-specific reported failures.
2. Add an explicit `endDate` to monthly report and monthly share inputs.
3. Make monthly ClickHouse queries use the explicit server input instead of
   `today()`.
4. Return report recovery metadata with the exact inclusive range and
   server-authored empty guidance from both report endpoints.
5. Capture repository failures and expose a safe range-specific retry message.

## Web

1. Add failing route/component tests for blocking failure recovery, cached-data
   warnings, retry state, processing-alert navigation, and exact empty guidance.
2. Add a reusable, accessible report recovery component with a Storybook
   scenario.
3. Keep cached report content and sharing controls rendered while displaying a
   non-blocking refresh warning.
4. Pass the server-authored empty message without calculating report dates in
   the client.

## iOS

1. Add the equivalent failing screen/component tests and Storybook scenario.
2. Add the matching native report recovery component.
3. Preserve cached report cards and sharing controls during refresh failures.
4. Wire retry to the affected query only and data review to `/alerts`.

## Validation

1. Run focused server, web, and mobile tests after each red/green slice.
2. Run formatter/lint, typecheck, changed unit/mobile tests, and the applicable
   integration tests.
3. Merge the latest `origin/main`, rerun required checks at the exact head, then
   publish the linked PR with `Fixes #2170`.
4. Address all actionable review feedback and CI failures at their root cause,
   then manually merge after the exact-head gates are green.
