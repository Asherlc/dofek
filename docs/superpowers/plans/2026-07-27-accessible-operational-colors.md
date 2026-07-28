# Accessible Operational Colors TDD Plan

**Goal:** Fix the confirmed light-theme contrast failures in generic operational states while preserving the separate domain-specific meanings of health, nutrition, training, and scoring colors.

**Behavior:** Web and mobile operational presenters use one shared `neutral` / `info` / `success` / `warning` / `danger` palette with `foreground`, `surface`, `border`, and `indicator` roles. Rendered normal text reaches 4.5:1 contrast, rendered state indicators and borders reach 3:1, and error/sync/processing states remain understandable without color.

**Scope:**
- Included: shared light-theme operational tokens; web/mobile query error panels; processing and recompute presenters; the web provider sync status badge; the measured web error fallback.
- Compatibility: retain the published `statusColors` API and its domain-oriented aliases; no server response or persisted-state changes.
- Non-goals: nutrition, training, health, correlation, clinical, or score threshold classification; tiny-label work tracked by #2099/#2189; semantic eligibility rules tracked by #2080.

**Standards:** [WCAG 2.2 contrast minimum](https://www.w3.org/TR/WCAG22/#contrast-minimum), [WCAG 2.2 non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast), [WCAG 2.2 use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color), and [React Native accessibility](https://reactnative.dev/docs/accessibility).

## Current Evidence

- `.query-error-panel` renders very light red text over a translucent dark-red layer on the light page, reproducing the audit's approximately 1.12:1 failure.
- Web and mobile generic processing presenters independently select framework-specific red/amber/green/blue colors.
- The web provider sync state is a color-only dot; its status name is exposed to assistive technology but not visually.
- The mobile query error presenter uses a dark surface with a light-theme title token, while its retry and alert semantics lag the web equivalent.

## Test Strategy

- Test rendered consumers rather than the static token file.
- Compute contrast from the actual rendered foreground, surface, border, and indicator values.
- Verify error announcements, retry behavior, and visible text/symbol cues.
- Verify equivalent web/mobile operational presenters map the same statuses to the shared roles.

## Tasks

### Task 1: Capture the failures

**Files:**
- Modify: `packages/web/src/components/QueryStatePanel.test.tsx`
- Modify: `packages/mobile/components/QueryStatePanel.test.tsx`
- Create: `packages/web/src/components/StatusDot.test.tsx`
- Modify: web/mobile processing and recompute component tests
- Create: `packages/web/src/components/ErrorBoundary.test.tsx`

- [x] Add rendered contrast assertions for query/error fallback text, surfaces, and borders.
- [x] Add alert, retry, and visible non-color cue assertions.
- [x] Add shared-role mapping assertions for processing and recompute presenters.
- [x] Run the focused suites and confirm they fail for the intended missing behavior.

### Task 2: Add the shared operational palette

**Files:**
- Modify: `packages/scoring/src/colors.ts`
- Modify: `packages/scoring/README.md`
- Modify: `packages/mobile/theme.ts`

- [x] Add the five operational roles with foreground/surface/border/indicator values.
- [x] Document their presentation-only contract and contrast targets.
- [x] Keep all existing public scoring/status color exports compatible.

### Task 3: Map web and mobile presenters

**Files:**
- Modify: web/mobile query, processing, and recompute components
- Create: mobile processing and recompute component stories
- Modify: `packages/web/src/components/StatusDot.tsx`
- Modify: `packages/web/src/components/ErrorBoundary.tsx`
- Modify: `packages/web/src/index.css`

- [x] Apply shared roles to generic operational states.
- [x] Add visible status labels/symbols and alert semantics.
- [x] Add equivalent native retry and announcement behavior.
- [x] Add visual variants for the modified mobile operational presenters.
- [x] Re-run focused suites until green.

### Task 4: Verify and ship

- [ ] Run formatting/lint, typecheck, focused tests, and relevant package builds.
- [ ] Commit and push the isolated issue branch.
- [ ] Open one PR closing #2068 and link the plan from the issue.
- [ ] Monitor all CI and review feedback, fixing actionable findings.
- [ ] Confirm the PR is based on the current exact `main`, then report merge readiness without merging.
