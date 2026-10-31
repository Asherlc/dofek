# Climb chart highlight implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this small, coupled change.

**Goal:** Link climb list hover/focus and mobile selection to HR annotations.
**Architecture:** Activity pages hold the active entry ID; panels emit it and charts emphasize matching existing annotations.
**Tech Stack:** React, ECharts, React Native SVG, Vitest.
**Spec:** [Approved design](../specs/2026-10-30-climb-chart-highlight-design.md).

## Global constraints

Keep existing maps, explicit detail actions, and server-supplied timing. No API or dependency changes.

## Review focus

Check pointer/focus precedence, repeated climb occurrences, missing timing, out-of-range annotations, and clearing highlights.

### Task 1: Connect and render highlights on both platforms

Modify each platform's ActivityClimbingPanel, ActivityDetailCharts, activity page, colocated tests, and stories. Panels emit `onHighlightEntry(id: string | null)` on web or `onSelectEntry(id: string | null)` on mobile; charts accept `highlightedClimbId?: string | null`.

- [x] Write tests for hover/focus precedence and cleanup, mobile repeated selection, and highlighted line/band rendering and clearing.
- [x] Run targeted Vitest files; expect new assertions to fail before implementation.
- [x] Implement callbacks, page state, and stronger existing annotation styles with visible labels.
- [x] Run targeted tests, typechecks, and Biome; expect success. Review the full diff.
- [x] Add an interactive list/chart story and inspect it in the browser.
- [x] Commit and push the completed change.

## Working notes

The user approved the short design in conversation. Execution stays in the existing worktree and branch. Review checkpoints: failing tests, green tests and static checks, then visual and final diff review.

Review found zoom reset on web and chart selection being suppressed after mobile list selection. Both received failing regression tests before fixes. Web retains zoom from ECharts events without rerendering during gestures; mobile shares selection between list and chart. Targeted verification: 51 tests passed across five files, both platform typechecks passed, and `pnpm lint:sandbox` passed. Browser checks confirmed line/range highlighting, clearing, and preserving a 10–80% zoom window.

Final full unit/mobile run: 1,431 files passed, two skipped; 23,599 tests passed, 19 skipped. No failures. No API, dependency, or infrastructure changes.
