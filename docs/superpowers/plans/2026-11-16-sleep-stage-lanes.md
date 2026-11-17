# Sleep Stage Lanes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this small, cohesive change in the current worktree.

**Goal:** Render recorded sleep stages as solid interval blocks in four labeled lanes on web and mobile.

**Architecture:** Keep ECharts on web and react-native-svg on mobile. Add server-computed duration seconds to parsed stage rows; each client formats those values and maps timestamps to display coordinates. Retain existing accessible disclosures with exact interval details.

**Tech Stack:** TypeScript, React, React Native, ECharts, react-native-svg, Zod, Vitest.

**Spec:** ../specs/2026-11-16-sleep-stage-lanes-design.md

## Global Constraints

- Work on the current branch; no branch switching, dependencies, SQL, ingestion, or schema-storage changes.
- Four lanes: Awake, REM, Light, Deep. Blocks occupy only recorded time; gaps stay blank.
- Use shared colors and existing formatting. Server supplies duration seconds.
- Both clients and their stories change together; preserve accessible exact values and empty/loading states.

## Review Focus

- Overnight and offset-aware intervals retain elapsed durations and proportional widths.
- Sparse records leave blank time rather than implying a stage across the gap.
- A single-stage night still has four readable lanes and a nonzero time domain.
- Brief awakenings retain their actual width and remain inspectable through exact values.
- Changing the selected night clears stale interval selection; persisted mobile data must meet the new response contract.

### Task 1: Sleep-stage interval presentation

**Files:** Server sleep-repository schema/tests; web and mobile Hypnogram components/tests/stories; mobile cache contract/tests; package READMEs.

**Interfaces:** Existing stage fields remain; parsed stage rows add `duration_seconds: number`. Charts consume that value without computing duration. Native and web exact-value controls expose stage/start/end/duration.

- [x] Write regressions for duration across midnight/offsets, real SVG blocks confined to four lanes, proportional widths and blank gaps, single-stage rendering, interval selection, and mobile cache invalidation.
- [x] Run the focused unit/mobile tests non-interactively and confirm the new regressions fail for missing behavior.
- [x] Implement the additive server duration projection and replace filled charts with interval blocks. Use existing accessibility controls; retain geometric timestamp calculations only in clients.
- [x] Update stories and fixtures, including sparse and short intervals, and package documentation with the ECharts reference.
- [x] Run focused tests, lint, all-package typechecks, and full unit/mobile suites. Inspect actual SVG rendering at wide/narrow sizes; interactive Storybook inspection remains blocked as recorded below.
- [x] Review the complete diff, resolve material findings, then commit and push on the existing branch.

## Working notes

- Initial worktree is clean on `improve-sleep-data-visualization`.
- Latest inspected CI run is still in progress, not a confirmed green baseline.
- User selection authorizes implementing A; execute directly without another design-choice prompt.
- Red/green: original baseline 21 passed; new lane/duration/cache tests initially failed, then 90 focused tests passed. Full unit/mobile suite passed 24,835 tests before final review fixes.
- Independent Architect review identified two material gaps: old server cache hits bypassed duration projection; exact values rounded away seconds. Both were reproduced by regression tests before fixes. Existing cache `outputSchema` now normalizes all sleep-stage hits; existing shared formatters accept explicit second precision.
- Review boundary decisions: retain existing provider/session selection and valid-positive-interval assumptions; no ingestion changes. Native device accessibility behavior and production release timing are not certified by unit tests. New native clients require the duration-capable API to be deployed first.
- Browser verification is blocked: Paseo tab registration timed out twice; native Paseo inspection also timed out. Actual ECharts rendering was inspected as SVG-derived PNG at 900px and 320px; this does not claim interactive browser/native-device verification.
- Final validation: all 24,843 unit/mobile tests passed after the review fixes; full lint, all-package typechecks and diff whitespace checks passed. Both Storybook indexes respond through their public preview tunnels. No SQL or storage behavior changed, so no database-engine tests or migrations were needed.
- Retrospective: actual SVG pixel checks and native geometry checks established the visual contract; independent review found the cache and precision boundaries. Proposed guidance for user approval: "When adding required response fields, test retained server-cache responses as well as persisted clients; exact interval disclosures retain recorded seconds." Existing testing and review skills suffice; no new skill is proposed.
