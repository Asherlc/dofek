# Activity Sources Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development. Track review checkpoints below.

**Goal:** Present source ancestry and device facts through one Sources disclosure.
**Architecture:** Reuse the existing tree; attach hardware by record ID. Share the hardware-to-tree presentation between clients. Keep independent hardware query state and show errors with retry.
**Tech Stack:** TypeScript, React, React Native, Vitest, Storybook.
**Spec:** `docs/superpowers/specs/2026-10-25-activity-sources-design.md`

## Global Constraints

- Implement equivalent behavior on web and mobile.
- Keep one Sources disclosure and no separate hardware disclosure.
- Nest reported hardware under its reporting provider (Peloton → WHOOP).
- Preserve source links, distinct sensors, device facts, and actionable errors.
- Use stable record IDs for association; never infer ancestry from labels.

## Review Focus

- Hardware-only/empty source trees must remain reachable.
- Unmatched hardware must not be lost.
- Cached data must survive a refresh failure.
- Nested provider branches must retain their correct facts and links.
- Collapsed content must hide facts; screen-reader expansion must match visibility.

### Task 1: Shared provenance wording
- [x] Add failing hierarchy tests for recorder details, reported devices, unmatched hardware, power, and immutability.
- [x] Add `activitySourceTreeWithHardware(tree, hardware): ActivitySourceTree` and optional node details.
- [x] Run the providers package tests and review the shared interface.

### Task 2: Web tree consolidation
- [ ] Write failing tests showing hardware facts opening with Sources, attached by activity ID, including unmatched/empty-tree and error/retry cases.
- [ ] Delete the standalone hardware panel. Extend Sources with hardware query props and render the shared tree with details beneath device nodes.
- [ ] Pass the eager hardware query from ActivityDetailPage into ActivityHeader/Sources and remove the standalone card.
- [ ] Update component/page stories for collapsed, expanded, Peloton metadata, loading, empty, and error states.
- [ ] Run affected web tests; inspect screenshots and review.

### Task 3: Mobile parity
- [ ] Apply the same failing-test-first changes to Sources, inline hardware facts, and activity header/screen wiring.
- [ ] Update matching stories and run affected mobile tests.
- [ ] Review parity against web and the approved design.

### Task 4: Verification and delivery
- [ ] Capture browser screenshots of collapsed/expanded tree at wide and narrow widths.
- [ ] Run lint, relevant unit/mobile tests, and required typechecks.
- [ ] Independent diff review; resolve actionable issues.
- [ ] Commit and push the finished change on the existing branch.

### Task 5: Specific Apple Watch model evidence
- [ ] Preserve HealthKit source product type through native transport, validation, and raw storage.
- [ ] Resolve identifiers to specific Apple Watch names; omit generic Watch model values.
- [ ] Run native and server tests; document the fresh-sync requirement for older uploads.
