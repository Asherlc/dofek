# Body heading hierarchy implementation plan

Issue: [#2143](https://github.com/Asherlc/dofek/issues/2143)

## Goal

Give the Body daily-heart-rate route one page heading and a correctly nested content heading without changing its visual presentation.

## Test-first steps

1. Assert that `AppHeader` branding does not claim heading semantics.
2. Assert that `PageLayout` renders its title as the page-level `h1`.
3. Assert that `DailyHeartRatePage` renders its title as an `h2`.
4. Assert that the mobile screen retains its single native navigation title.
5. Make the minimum semantic element changes, update directly affected stories, and run focused web/mobile validation plus typechecks and lint.

## Runtime audit

Verify the web outline through the rendered public components and verify the existing iOS navigation title with a native accessibility snapshot. Do not add a duplicate mobile content heading.
