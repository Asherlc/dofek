# Climbing area lineage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the approved single-line area lineage in web and mobile grouped climbing logs.

**Architecture:** Extend the existing grouping result with the recorded path. Four existing consumers render the same data with stock text and horizontal scrolling. No dependency, schema, or API changes.

**Tech Stack:** TypeScript, React, React Native, Tailwind, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-11-09-climbing-area-lineage-design.md`

## Global constraints

- Entire recorded root-to-leaf path, separated by `›`, once per group; final area bold, parents subdued.
- One visual line; long paths scroll horizontally without truncation. Web scrolling is keyboard accessible, and the full accessible heading identifies the area.
- Web and mobile parity, including attached/unattached activity panels and grouped breakdowns.
- Preserve grouping, numbering, selection, attachment, and existing missing-area presentation.
- Use existing data and stock platform capabilities. No new dependencies, wrapper components, schema, or API fields. The web heading's native named scroll region is the necessary keyboard-scrolling container.
- Stay on `add-area-field-ui`; do not switch/rebase branches. Do not commit brainstorm scratch files. Do not recursively delegate.

## Review focus

- Multi-level paths retain every supplied parent in order; no invented location.
- Very long names remain available at narrow widths without wrapping or clipping the leaf permanently.
- Single-area paths have no leading separator; missing paths retain existing fallbacks.
- Matching paths across providers retain current grouping and the first group's presentation path.
- Native nested horizontal headings preserve vertical selection/reveal measurements and accessible headings.

### Task 1: Render the complete area path on both clients

**Files:**
- Modify `packages/training/src/climbing-log-groups.ts` and its colocated test.
- Modify `ActivityClimbingPanel.tsx` and `ClimbingLogEntryBreakdown.tsx` in `packages/web/src/pages/activity-detail/components/` and `packages/mobile/components/`, with their colocated tests and existing stories.
- Update the climbing-group paragraphs in `packages/web/README.md` and `packages/mobile/README.md`, citing the implementation and official scrolling documentation.

**Interfaces:**
- Consume `entry.climb.areaPath` (root-to-leaf recorded area nodes).
- Produce `areaPath: readonly SourceArea[]` on every result of `groupClimbingLogEntriesByArea`, retaining all existing fields and grouping semantics. Missing paths yield `[]`; grouped entries retain the first entry's path.

- [ ] Write failing tests: assert the grouping result retains full/empty paths, renders the full multi-level lineage on web/mobile panels and breakdowns, preserves leaf-only/missing-path behavior, and handles unattached suggestions. Update existing exact group expectations for the added field. Keep tests focused on behavior, not CSS string assertions.
- [ ] Run the focused Vitest files with `pnpm exec vitest run <files> --project unit --project mobile`; observe the new expectations fail for missing lineage.
- [ ] Add `areaPath` to the existing grouping result and render parent nodes with `›` separators and a bold final node. Use named, focusable `overflow-x-auto whitespace-nowrap` regions containing ordinary headings on web, and horizontal `ScrollView` headings on mobile, preserving full accessible names. No ellipsis or hardcoded parent names in production.
- [ ] Update existing stories with complete real-name hierarchies and a narrow long-path case. Update any native ScrollView test doubles to preserve the real component's prop distinctions instead of labeling nested headings as the climb list.
- [ ] Re-run focused tests, including existing selection/attachment tests, and review the actual diff against the spec and review focus.
- [ ] Run repository lint and root/server/web/mobile TypeScript checks, then the unit/mobile suite. Inspect stories in a browser at narrow and wide widths; retain honest evidence if browser tooling is unavailable.
- [ ] Lead reviews the final diff and evidence, then commits, pushes, opens the PR, and monitors CI and reviews using ship-pr. Never merge automatically.
