# Garmin Device Thumbnails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** Show the specific Garmin recording device's product thumbnail on web and iOS.

**Architecture:** Add one local model lookup to the shared provider metadata package and consume it through the existing web/mobile `ProviderLogo` components. Preserve the Garmin logo for unsupported names and failed images.

**Tech Stack:** TypeScript, React, React Native, Vitest, existing Storybook.

**Spec:** `docs/superpowers/specs/2026-10-24-garmin-device-thumbnails-design.md`

## Global Constraints

- Implement the feature on both web and mobile without adding dependencies.
- Preserve Apple Health source badges and provider-only Garmin logos.
- Do not change branches, ingestion, storage, origin selection, or device priorities.
- Match specific models conservatively; unknown or ambiguous names retain the Garmin logo.
- Report failed image loads through the existing platform telemetry boundary.

## Review Focus

- Unicode names and grouped sizes must match the corresponding product model.
- Unknown variants must not silently inherit a different model's thumbnail.
- An image failure followed by a changed source must allow the new image to load.
- Non-Garmin providers and Apple Health attribution must retain their current rendering.
- Both clients must use the same model selection and preserve image aspect ratio.

### Task 1: Shared lookup and both icon renderers

**Files:** Shared Garmin lookup/catalog/test and package export under `packages/providers-meta`; web/mobile `ProviderLogo` components, tests, and stories; recording-icon labels in web `ActivityCardContent` and mobile activities route and their existing tests.

**Interfaces:** Add `garminDeviceThumbnail(sourceName: string | null | undefined): string | null` exported through `@dofek/providers/garmin-devices`. It returns a catalog image URL or null. Clients use it only for Garmin recording sources. Existing `providerRecordLabel` provides provider/model accessible labels.

- [x] Write failing behavioral tests for Forerunner 965, Edge 1050, fēnix 8 sizes, normalized names, unsupported models, and unknown variants.
- [x] Run the targeted tests and confirm the new behavior fails before implementation.
- [x] Add the compact catalog snapshot and conservative shared lookup. Add product thumbnails to both clients with contained sizing and failure fallback; reset failure by image URL rather than by effect.
- [x] Add matching web/mobile stories for a watch, bike computer, and unknown model; update recording-icon accessible labels and their existing tests.
- [x] Run affected unit/mobile tests; self-review the diff and record evidence.

### Task 2: Review, validate, and push

**Files:** Active provider metadata documentation and implementation notes above.

**Interfaces:** Consume the completed Task 1 changes and existing test/build commands.

- [x] Independently review the complete feature diff for spec compliance and code quality; address material findings.
- [x] Run shared/web/mobile type checks, relevant lint and tests, and a web build/size check.
- [x] Inspect rendered web/mobile stories with browser tooling; any HTTP server must retain its required quick tunnel for its lifetime.
- [x] Update the shared package README with the catalog source and fallback behavior; mark plan steps with verification evidence.
- [x] Commit the completed change on the current branch and push it automatically.

## Verification notes

- Initial behavior tests failed before implementation; six affected suites then passed all 157 tests. Review added a generic-qualifier regression, observed its failure, and passed all 62 shared lookup/label tests after removing four incomplete catalog aliases.
- Final verification on the reviewed code passed all 163 tests in the six affected suites with retries disabled.
- Independent feature review and the scoped alias-fix review approved spec compliance and code quality.
- Shared, web, and mobile type checks passed; `pnpm lint:sandbox` passed.
- Final production web build and size checks passed: JavaScript 496.24 kB gzipped against 697.1 kB; CSS 20.09 kB against 50 kB.
- Browser inspection loaded the expected Forerunner 965, Edge 1050, and fēnix 8 images on web and mobile stories at 32 × 32 px, with no page errors. The mobile check uses React Native Web component stories rather than a native Simulator audit.
- The repository-wide Docker-free unit/mobile run was intentionally stopped after proving broader than this UI change requires. Its completion is not claimed; final validation uses the six affected suites plus typechecks, lint, build/size, independent review, and browser inspection.

## Retrospective

Existing source-name inputs and a shared metadata package kept platform behavior
consistent. Catalog alias quality and development-server caching after adding a
package export required investigation. The shared package README now records
the catalog source, image verification, and complete-name-only refresh rules.
Future additions should reuse TDD and browser component checks; a repeatable
catalog-refresh command would be useful if updates become frequent.
