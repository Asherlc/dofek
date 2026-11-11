# Activity Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Restore clear activity identity with shared custom outline icons and compact recording-source disclosures on web and mobile.

**Architecture:** Keep custom SVG geometry and category mapping in the existing training package. Share recording-app/import-role presentation in the providers package. Render a Radix popover on web and an existing-pattern native modal on mobile, separate from card navigation.

**Tech Stack:** TypeScript, React, React Native, existing SVG renderers, Radix Popover 1.3.1, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-10-24-activity-identity-design.md`

## Global Constraints

- Match the approved rounded-outline sample in `work/activity-icon-styles/outline-*.svg` and source-disclosure option C.
- Replace all 16 existing icon families, without altering the 90-type taxonomy or the category mapping.
- Keep activity identity visible even when origin is resolved or a map is present.
- Keep source names behind the disclosure; its trigger shows only the recording-app logo and a disclosure cue.
- Source interaction must not navigate, select, or nest interactive HTML controls.
- Use shared SVG geometry and source presentation across platforms; do not change server/storage/metric behavior.
- Write failing behavior tests before implementation, and do not add exports solely for tests.
- Do not switch branches, merge, deploy, or commit mockup output. The controller owns git staging/commits/pushes.

## Review Focus

- Apple Health subsource names can be known aliases or unknown apps; preserve their identity and import role.
- Direct providers and Apple Health without a separate subsource must not produce duplicate import rows.
- Unresolved origins must retain activity identity without fabricated recording attribution.
- Map-bearing cards and selection mode must preserve both source access and the existing card action.
- Outline glyphs must remain recognizable and theme-visible at compact sizes on web and native.

---

### Task 1: Shared custom outline icons and all activity-icon renderers

**Files:**
- Modify: `packages/training/src/activity-icons.ts`, its colocated tests, and `packages/training/README.md`.
- Create if needed: one focused training source module for the 16 SVG geometries.
- Modify: web/mobile `ActivityTypeIcon` components, tests, and stories.
- Modify: mobile `components/ActivityCard.tsx` and `app/activity/[id].tsx` plus their existing tests to remove emoji bypasses.

**Interfaces:**
- Preserve `resolveActivityIconCategory(activityType: string)` and `getActivityIconInfo(activityType: string)` production API responsibilities; migrate all actual consumers if the icon-info shape changes.
- Every existing category has a canonical SVG; renderers accept a supplied/theme color rather than hardcoding a light-only palette.
- Do not edit web `ActivityCardContent` or mobile `app/(tabs)/activities.tsx`; Tasks 2/3 own those.

- [x] Write failing tests for canonical SVG/category behavior and platform rendering, including a common activity, hangboarding, unknown fallback, and existing compact variants.
- [x] Run focused unit/mobile tests to demonstrate the expected failure.
- [x] Implement the coherent 16-glyph family and migrate both `.emoji` bypasses to the canonical renderer. Preserve component size/layout contracts where appropriate.
- [x] Update relevant stories with a complete icon-family gallery and compact/theme examples, and update training README with local-source and SVG citations.
- [x] Run focused tests and typechecks as needed; self-review and write the task report. Controller reviews and commits this task.

### Task 2: Shared source roles and web disclosure

**Files:**
- Create: `packages/providers-meta/src/activity-source-details.ts` and colocated test; export via package manifest.
- Create: web `ActivitySourceDisclosure.tsx`, test, and story.
- Modify: web `ActivityCardContent.tsx`, its tests/stories, `pages/ActivitiesPage.tsx`, related interaction tests, web package manifest/lockfile, and web README.

**Interfaces:**
```ts
export interface ActivitySourceApp { provider: string; label: string }
export interface ActivitySourceDetails {
  recordingApp: ActivitySourceApp;
  importedVia: ActivitySourceApp | null;
}
export function activitySourceDetails(origin: ActivityOrigin): ActivitySourceDetails | null;
// Public import: @dofek/providers/activity-source-details
// null means unresolved origin. Use providerSourceLogo/providerLabel internally.
// Web component:
// ActivitySourceDisclosure({ origin }: { origin: ActivityOrigin })
```

- [x] Write failing shared tests for direct WHOOP, Hang Ten aliases, Strong, unknown apps, Apple Health-only, and unresolved origin.
- [x] Write failing web tests for opening/closing source details, Escape/focus return, clean recording-only logo, map/resolved activity icon, and card navigation/selection isolation.
- [x] Run focused tests and confirm expected failures.
- [x] Add the verified latest stable `@radix-ui/react-popover` version `1.3.1` using pnpm, then implement source roles and the accessible anchored disclosure.
- [x] Make card navigation/selection and source control separate valid interaction targets; preserve existing actions and selection labels.
- [x] Update stories and README, citing Radix and shared contracts for relevant claims.
- [x] Run focused tests; self-review and write the task report. Controller reviews and commits this task.

### Task 3: Mobile source disclosure and activity-list parity

**Files:**
- Create: mobile `ActivitySourceDisclosure.tsx`, test, and story.
- Modify: `packages/mobile/app/(tabs)/activities.tsx`, its `app-tests` tests and route stories, and mobile README.

**Interfaces:**
- Consume `activitySourceDetails` from Task 2 with the exact interface above.
- Mobile component: `ActivitySourceDisclosure({ origin }: { origin: ActivityOrigin })`.
- Use Task 1's `ActivityTypeIcon` for leading identity and `ProviderLogo` for the resolved recording app without an Apple Health overlay in the trigger.

- [x] Write failing tests for source opening/closing, direct and Apple Health roles, clean recording-app trigger, unchanged card navigation/selection, and activity icons with maps/resolved sources.
- [x] Confirm focused mobile tests fail for the intended behavior.
- [x] Implement the source control using the existing native Pressable/Modal pattern with accessible labels, dismissal, and a practical touch target; keep card action independent of the source action.
- [x] Update stories for direct WHOOP, Hang Ten via Health, unresolved origin, map cards, and selection mode; update README with appropriate primary-source citations.
- [x] Run focused mobile tests and typecheck; self-review and write the task report. Controller reviews and commits this task.

### Final validation

- [x] Review all task diffs, then review the combined change for spec compliance and code quality.
- [x] Run appropriate unit/mobile suites, typechecks, lint, and web build/size checks. Do not broaden passing tests without a specific unresolved concern.
- [x] Inspect the actual web and mobile Storybook renders at compact/wide widths, opening/closing source details. Start the required quick tunnel for every HTTP development server and keep it alive for that server's lifetime.
- [x] Commit only durable source/docs/tests/assets, push all new commits automatically to the existing remote branch, and report tests, screenshots, and any limitations.

## Verification and review record

- All three task reviews and the combined review approved the implementation.
- Docker-free unit/mobile run: 1,327 test files passed, 2 skipped; 20,520 tests
  passed, 19 skipped; retries disabled. Duration: 706.25 seconds.
- Full lint, root/server/web/mobile typechecks, and production web build passed.
- Final bundle checks: JavaScript 502.87 kB gzipped against 697.1 kB; CSS
  20.25 kB against 50 kB. Limits were unchanged.
- Seven real-browser Storybook checks passed with zero runtime errors: both
  16-icon galleries, web recording/import roles and focus restoration, 390-pixel
  layout, independent source/navigation/selection hit targets, and mobile source
  opening/roles/dismissal. Native components were checked through unit tests and
  Storybook; a native Simulator/VoiceOver audit was not performed.
- Visual review corrected the water-family surfer and team-family field-ball
  silhouettes. Compact checking identified an existing fixed-width Storybook
  wrapper; its responsive fixture was corrected without changing product layout.
- Local Docker subnet exhaustion blocked the lint prerequisite until one
  inspected empty bridge was removed; the original Compose command and full
  lint then succeeded. See the [incident baseline](../../production-incident-baseline.md).

The shared geometry and source-role helper kept the clients aligned. The main
integration work was separating source controls from whole-card actions.
A useful future review rule is to verify card-background, map, secondary-control,
and keyboard hit targets at phone widths when adding controls to tappable cards.
