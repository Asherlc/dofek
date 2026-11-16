# WHOOP Skin Temperature Implementation Plan

Follow the tasks below in order and verify each acceptance criterion before continuing. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show recorded skin temperature on activities and web Recovery while proving whether the reported missing data exists.

**Architecture:** Reuse decoded `analytics.daily_health_sensor` samples and the existing activity source-selection and stream path. Reuse daily metrics and existing charts for Recovery; preserve the mobile card already present.

**Tech Stack:** TypeScript, tRPC, Zod, ClickHouse, React/ECharts, React Native SVG, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-whoop-skin-temperature-design.md`

## Global Constraints

- Stay on the existing branch; do not switch, create a branch, or rebase.
- No dependencies, schema migrations, new read models, native BLE changes, deployment changes, or production mutations.
- Use `skinTemperature` for the activity metric and `skin_temperature` for decoded samples; ambient `temperature` is different.
- Cloud daily recovery values must never be fabricated into activity observations.
- Preserve user/activity isolation, provider/device identity, source priority, missing values, gaps, and existing chart timelines.
- Use existing °C/°F conversion and chart components; compute metric values on the server.
- Follow repository TDD, story, real-engine integration, lint, and all-package typecheck requirements. Prefix shell commands with `rtk` and use pnpm.
- Never recursively delegate. Do not start HTTP servers unless needed; every HTTP development server requires the standing quick-tunnel command.

## Review Focus

- Sparse temperature observations interleaved with dense HR must survive downsampling and retain meaningful timing.
- A temperature-only activity window must display the channel even without other chart samples.
- Replayed BLE records and overlapping devices must not produce double-counting or blend selected sources.
- Wrong-user, out-of-window, erased, and unrelated activity observations must stay excluded.
- Missing temperatures and generic ambient temperatures must not become skin-temperature values, including cached older client responses.

### Task 1: Establish the missing-data boundary

**Files:** Local working notes; final incident entry in `docs/production-incident-baseline.md`.

**Interfaces:** Consumes read-only production logs, raw daily metrics, decoded health samples, actual cached API response, existing Firefox session. Produces an evidenced cause rather than an assumed ingestion defect.

- [x] Confirm cloud temperatures, BLE upload publication, decoded samples, and served daily values.
- [x] Reproduce missing web Recovery section; confirm Body chart renders with served data.
- [x] Record that web Recovery never queries/renders temperature; no missing ingestion proven.
- [x] Append a concise dated incident record with evidence and remaining mobile-runtime limitation.

### Task 2: Add activity temperature and complete Recovery parity

**Files:**
- Modify `packages/server/src/contracts/activity-metric-sources.ts`, `packages/server/src/repositories/activity-metric-sources-repository.ts`, `packages/server/src/repositories/clickhouse-activity-sensor-store.ts`, `packages/server/src/repositories/activity-repository.ts`, `packages/server/src/routers/activity.ts`, and their relevant tests.
- Modify activity chart/page/source-picker consumers and stories in `packages/web/src/pages/ActivityDetailPage.tsx`, `packages/web/src/pages/activity-detail/components/ActivityDetailCharts.tsx`, `packages/mobile/app/activity/[id].tsx`, `packages/mobile/components/activity/ActivityDetailCharts.tsx`, and necessary API types/fixtures.
- Modify `packages/web/src/routes/training/recovery.tsx` and its tests/range-plumbing fixtures. Verify existing mobile Recovery tests and update stories as needed.
- Update relevant package README sections to describe final UI behavior with source-code references.

**Interfaces:** Consumes existing `ActivitySensorWindow`, `ActivityMetricSourceSelection`, `ActivityMetricSources`, `StreamPointRow`, `StreamPoint`, `healthSensorSamplesSql("skin_temperature")`, and daily-metrics API. Produces a selectable `skinTemperature` activity channel and visible web Recovery chart, preserving existing caller contracts where possible.

- [x] Write focused regression tests first: activity source discovery finds temperature devices; selected streams return overlapping BLE readings while preserving HR and excluding another user/outside-window data; duplicate timestamps resolve once; temperature-only and staggered/downsampled readings survive. Use real ClickHouse fixtures, including the existing daily-health-sensor model/table helpers. Run via `rtk pnpm test:integration -- packages/server/src/repositories/activity-metric-sources-repository.integration.test.ts` and observe feature assertions fail. Add any narrowly needed owning-file tests for stream shapes.
- [x] Add UI regression tests that assert actual temperature chart values/units for web and mobile activities, plus web Recovery rendering and finite/All range plumbing. Observe failures using `rtk pnpm exec vitest run --project unit <web test paths>` and `rtk pnpm exec vitest run --project mobile <mobile test paths>`; save JSON/log evidence under `/tmp/opencode/whoop-skin-temp/`.
- [x] Extend the existing activity metric and source queries with decoded temperature samples. Reuse bounded projection from `analytics.daily_health_sensor FINAL`, not packet decoding or raw-stream reads. Preserve stable provider/device source IDs and apply the existing explicit source selection. Update stream serialization/downsampling and all affected typed consumers/fixtures. Default/validate old cached response fields only where actual client compatibility requires it; do not add test-only guards.
- [x] Render the temperature series beside other activity metrics on both clients with existing chart/hover/source-control behavior and formatted selected units. Add default/data, sparse, loading, and empty story coverage through existing activity stories.
- [x] Render a web Recovery skin-temperature chart using `dailyMetrics.list`, selected dates, `TimeSeriesChart`, and existing unit context. Keep errors visible, retain cached data on refetch, and distinguish loading/empty. Verify the existing mobile card and its missing-data behavior without guessing an ingestion fix.
- [x] Run the relevant integration, unit, and mobile suites; inspect and fix failures. Run `rtk pnpm lint` and `rtk pnpm --recursive --include-workspace-root --if-present typecheck`, saving reports. Prepare ClickHouse through the workspace Compose wrapper as documented. No local E2E unless E2E files change.
- [x] Review actual diff for acceptance, minimal maintained concepts, parity, and evidence. Obtain independent whole-change review; resolve material findings. Commit and push after required checks, update the ledger and progress dashboard.

## Final verification

The real-engine source-selection, hardware-label, and stream-lifecycle suites passed (26 tests). Amended unit/web tests (115) and mobile activity/chart tests (109) passed; prior unchanged mobile Recovery evidence remains valid. Repository lint and recursive all-package typechecks passed. An independent whole-change review and its single scoped fix review accepted the result with no remaining material findings. No local E2E, production deployment, or physical-device BLE audit was performed. The original activity source, live daily response, and completed Body page established that missing web Recovery UI was not missing ingestion.
