# Responsive Correlation Controls Implementation Plan

**Issue:** [#2148](https://github.com/Asherlc/dofek/issues/2148)

**Goal:** Keep correlation controls readable and operable at narrow web viewports without changing
the already-stacked native mobile controls.

**Approach:** Use Tailwind's mobile-first responsive utilities to stack the X and Y metric selects
by default, restoring the horizontal X / vs / Y arrangement at the `sm` breakpoint. Let lag choices
wrap and render the full comparison sentence in a separate block below them, matching the native
screen's existing structure. This avoids the flex `nowrap` overflow described by MDN while
preserving the desktop layout.

Sources:

- [Tailwind responsive design](https://tailwindcss.com/docs/responsive-design)
- [Tailwind flex wrap](https://tailwindcss.com/docs/flex-wrap)
- [MDN: Wrapping flex items](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Flexible_box_layout/Wrapping_items)

## Tasks

1. Extend `CorrelationExplorerPage.test.tsx` with a failing regression assertion for the
   mobile-first metric grid, wrapping lag options, and structurally separate comparison sentence.
2. Update `CorrelationExplorerPage.tsx` with the approved responsive layout and rerun the focused
   test.
3. Add a `NarrowViewport` scenario to `CorrelationExplorerPage.stories.tsx`.
4. Validate the focused web test, the existing native correlation test, Storybook, typecheck, lint,
   and changed-test suite.
5. Open a linked PR with `Fixes #2148`, document that the audited surface is responsive web rather
   than native mobile, monitor CI and reviews, address actionable feedback, and merge.
