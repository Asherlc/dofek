# Compact Activity Source Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Apply the approved icon-badge treatment to web and mobile activity metric source controls.

**Architecture:** The server returns structured presentation alongside each stable source ID and full label. Each client renders that presentation in a reusable source picker, using existing logos and dialog primitives.

**Tech Stack:** TypeScript, Zod, React, React Native, Radix Dialog, Vitest.

**Spec:** [Approved design](../specs/2026-10-25-activity-source-attribution-design.md).

## Global Constraints

- Both platforms use A: icon badges; full wording stays in the chooser and accessible names.
- No new dependencies, parsed display strings, parsed source IDs, or inferred sync-health states.
- Source identity, priority, defaults, and metric selection semantics stay intact.
- Reuse [provider logos](../../../packages/web/src/components/ProviderLogo.tsx) and [dialog behavior](../../../packages/web/src/components/ModalDialog.tsx).

## Review Focus

- Unknown providers retain their name without invented attribution (Task 1).
- Separate records with identical names retain separate IDs and selectable choices (Tasks 1–3).
- Recorder and file-creator qualifications remain available in full source labels (Tasks 1–3).
- Keyboard selection, Escape, and focus return work in the web chooser (Task 2).
- Persisted mobile source responses without presentation cannot hydrate into the new control (Task 3).

### Task 1: Structured source presentation

**Files:** `packages/providers-meta/src/activity-metric-source.ts` and its test; package exports; server source contract/repository/tests; `packages/training/src/fixtures/activity-metric-sources.ts`.

**Interfaces:** Export `activityMetricSourcePresentationSchema`, `ActivityMetricSourcePresentation`, `ActivityMetricSource`, and `activityMetricSourcePresentation(providerId: string, sourceName: string | null, fullLabel: string)`. Add required `presentation` to every source: `{displayName, providerId, sourceName, attribution: {kind: 'apple_health' | 'cloud' | 'bluetooth', label: string} | null}`. `ActivityMetricSource` contains `id`, full `label`, and `presentation`.

- [ ] Write failing tests for Apple Health, WHOOP Cloud/Bluetooth, BLE monitors, unknown providers, and retained qualified labels; assert existing IDs/defaults remain.
- [ ] Run those unit tests and confirm the missing presentation fails.
- [ ] Implement explicit attribution mapping from provider/source metadata; preserve full labels. Add presentation to fixtures without parsing fixture labels.
- [ ] Run formatter/repository unit tests and typecheck shared packages.
- [ ] Review mapping against the approved design before clients integrate.

### Task 2: Web picker

**Files:** New `packages/web/src/components/ActivityMetricSourcePicker.tsx`, colocated test/story; activity detail page and metric chart; affected tests/stories.

**Interfaces:** Picker consumes `{label: string, sources: ActivityMetricSource[], selectedId: string, onChange(sourceId: string): void, className?: string}`. Trigger shows logo, display name, attribution icon, and chevron. Existing `ModalDialog` opens full-label radio choices.

- [ ] Write failing picker tests for compact trigger, full accessible attribution, duplicate names with distinct IDs, source switching, Escape, and focus return.
- [ ] Implement using existing logos/dialog; use plain SVG cloud/Bluetooth marks without a new icon dependency.
- [ ] Replace both native metric-chart selects and the elevation select with this picker. Preserve metric visibility toggles.
- [ ] Update source fixtures in affected tests and add production-component stories for Health, Cloud/Bluetooth, and unknown attribution.
- [ ] Run picker, metric chart, and activity detail tests; review layout at desktop and 390 pixels.

### Task 3: Mobile picker

**Files:** New `packages/mobile/components/activity/ActivityMetricSourcePicker.tsx`, colocated test/story; existing chart module/import consumers; activity route tests; persistence policy/tests if needed.

**Interfaces:** Same source type and callback as Task 2, plus existing `showLabel?: boolean` and `serverUrl: string` where needed by logos. Move the current picker out of the chart module and update all production/story imports directly.

- [ ] Write failing tests for compact source name/badge, complete accessible label, source switching, duplicate names, and selection state.
- [ ] Implement with existing RN modal/radios, ProviderLogo, and Ionicons. Retain 44-point minimum targets and the current view-only selection behavior.
- [ ] Update route tests and structured story inputs.
- [ ] Inspect persisted-query policy; invalidate old metric-source responses if persisted, with an executable hydration regression.
- [ ] Run mobile picker/route/persistence tests and typecheck; review actual rendered layout at 390 pixels.

### Task 4: Review and delivery

- [ ] Independently review shared metadata and both client diffs against the design.
- [ ] Run relevant unit/mobile tests, all required package typechecks, full lint, and diff checks.
- [ ] Capture actual production-component stories with icon badges on both clients; provide screenshots in chat and direct story links.
- [ ] Commit and push verified changes; record completed review checkpoints here.
