# Sentry Remediation Implementation Plan

Execute the tasks in order. For each task, reproduce the failure, implement the fix, and complete an independent specification and quality review. Finish with whole-branch review and the validation gates listed below. Checkboxes record progress.

**Goal:** Fix confirmed production defects, preserve actionable private diagnostics for opaque failures, and resolve Sentry issues only after verified recovery.

**Architecture:** Use native ClickHouse aggregate projections for source freshness, exact cache-key eviction for missing resources, and TanStack's native lifecycle integration. Preserve existing privacy boundaries while retaining safe storage and Apple authorization error classifications.

**Tech Stack:** TypeScript, dbt/ClickHouse, Redis, TanStack Query, Expo/Swift, Vitest.

**Spec:** The scope below records the user's approved remediation approach and the evidence in the [incident baseline](../../production-incident-baseline.md).

## Scope

The user approved freshness projections, unavailable-activity cache eviction, mobile focus/connectivity integration, regression tests, and sanitized diagnostics for persistence and Apple sign-in failures. Historical server issues 3B, 6B, 6D, 6E, and 6F have verified deployed fixes or recovery; do not add unrelated behavior changes for them. The active analytics issue is [6C](https://east-bay-software.sentry.io/issues/DOFEK-SERVER-6C), cache issues are 6G/6J/6H, and mobile issues are 19/1E/1R/1S/1Q/1G. The September 17 gateway error still needs origin evidence; do not claim instrumentation alone resolves unknown failures.

## Global Constraints

- Work on `resolve-all-sentry-issues`; do not switch branches.
- Write a failing behavioral test before implementation. Database semantics require executable tests against the actual engine.
- No timeout, retry, thread-limit, or error-suppression workaround.
- Preserve raw records, visibility/tombstone behavior, and user-isolated cache data.
- New mobile diagnostic telemetry must not contain cache keys, account/record identifiers, cached health data, tokens, arbitrary native messages, or NSError userInfo.
- Required dependencies must be explicit. Preserve direct API NOT_FOUND errors and genuine cache refresh failures.
- Read root and local README/AGENTS; prefix shell commands with `rtk`.
- Controller owns commits and immediately pushes every commit after required pre-push checks. Implementers do not commit, push, deploy, modify issue statuses, or spawn agents.
- Production SSH is read-only. Historical projection materialization is a separately reviewed operator action, not a deployment backfill.
- New native modules or patched native behavior require a new Expo runtime and native build; do not deliver incompatible JavaScript to runtime 1.1.

## Review Focus

- Projections must preserve freshness for tombstones and avoid unrelated clean history scans.
- Full refresh must recreate projections; existing targets must receive schema-only migration definitions.
- Eviction must remove exactly one payload and registration; real errors and eviction failures must remain visible.
- Initial background/offline states and listener cleanup must stop polling without blocking foreground recovery.
- Diagnostics must preserve safe failure classification and original propagation without exposing native userInfo or cache content.

### Task 1: Route source freshness projections

**Files:** Modify `analytics/models/read_models/activity_sensor_sample.sql`, `activity_location_sample.sql`, `activity_route_identity.sql`; extend `src/db/activity-route-identity-read-model.integration.test.ts`; add the next schema-only ClickHouse migration and register it; update the analytics operational runbook.

**Interfaces:** Retain the existing sensor projection's `max(refresh_version)` aggregate and add `maxIf(refreshed_at, channel = 'altitude')`. Match the route altitude query to that expression without a channel WHERE filter. Add a location projection matching `max(greatest(source_refreshed_at, refreshed_at))`, grouped by activity/user. Follow [ClickHouse projection guidance](https://clickhouse.com/docs/concepts/features/projections/projections).

- [x] Write a regression with unchanged dense altitude/location history on a second route, a small change to the first route, and an unscoped incremental route build limited to `max_rows_to_read = 50000`. Assert correct changed/unchanged outputs and retain deletion coverage.
- [x] Run `pnpm test:integration -- src/db/activity-route-identity-read-model.integration.test.ts` and record the expected scan-budget failure before code changes.
- [x] Implement matching dbt projections, query aggregates, and schema-only migration. Do not materialize historical data during deployment.
- [x] Run the same integration suite; inspect actual projection use and read budget. Run analytics compile/lint/policy checks.
- [x] Document bounded historical projection materialization and verification as an explicit operator step with official citations.

**Review checkpoint:** Independent spec and quality review passed. Real ClickHouse regression: 20/20, naturally selected both projections, 115/117 rows read for changed/tombstoned route builds. Compile and analytics policy passed. Normal SQL lint passes with its existing file-size guard; direct route lint exposes a pre-existing SQLFluff MATERIALIZED-CTE parser limitation. Production materialization and recovery remain pending.

### Task 2: Evict unavailable resources during cache warming

**Files:** Modify `src/lib/cache.ts`, `scripts/warm-query-cache.ts`, and affected required-input call sites/test fixtures; extend their colocated unit suites and add actual Redis coverage where needed.

**Interfaces:** Add exact `invalidate(key: string): Promise<void>` to canonical CacheStore implementations. Inject a required invalidation dependency into registry replay. Redis removal covers both `query-cache:data:<key>` and `query-cache:keys` membership, using [DEL](https://redis.io/docs/latest/commands/del/) and [SREM](https://redis.io/docs/latest/commands/srem/).

- [x] Write tests for NOT_FOUND eviction and skipped count, successful siblings, retained old values on ordinary/internal errors, failed eviction reporting, and exact Redis removal preserving adjacent/other-user keys.
- [x] Run focused warmer/cache tests and record the expected failures before implementation.
- [x] Evict semantic NOT_FOUND entries during warming, increment skipped, and omit failed processing outcomes. Preserve direct request errors and genuine refresh failures.
- [x] Run focused tests plus real Redis validation and server/root typechecks.

**Review checkpoint:** Independent spec and quality review passed. Focused unit tests: 60/60; direct request NOT_FOUND regressions: 7/7; real Redis exact eviction: 1/1. Root/server typechecks passed. Production replay verification remains pending deployment.

### Task 3: Connect mobile query polling to lifecycle and connectivity

**Files:** Add `packages/mobile/lib/mobile-query-lifecycle.ts` and its colocated tests; wire it once in `packages/mobile/app/_layout.tsx`; update existing mobile test fixtures and native dependencies/runtime configuration if necessary.

**Interfaces:** Export `registerMobileQueryLifecycle(): () => void` for the root layout effect. Initialize focus from current AppState; update focusManager and onlineManager from app and network events; remove subscriptions on cleanup. Use the canonical supported Expo connectivity module, checking and pinning the current stable compatible version if adding it. Follow [TanStack React Native guidance](https://tanstack.com/query/latest/docs/framework/react/react-native) and [Expo network documentation](https://docs.expo.dev/versions/latest/sdk/network/).

- [x] Write tests that exercise actual QueryObserver polling through initial background state, foreground, background, offline, recovery, and cleanup.
- [x] Run the focused mobile test and record the expected failure before implementation.
- [x] Implement lifecycle registration, root effect, and connectivity wiring. Preserve unexpected network-error reporting.
- [x] Run focused tests and the relevant root layout tests; confirm native runtime compatibility and dependency installation.

**Review checkpoint:** Independent spec and quality review passed. Lifecycle/root suites: 31/31; mobile typecheck and telemetry/route/dependency policies passed. ExpoNetwork 57.0.2 matches SDK 57 metadata; frozen install passed. Runtime 1.2 is required. Combined generic-iOS Release archive passed; physical-device delivery remains pending.

### Task 4: Preserve private persistence and native Apple diagnostics

**Files:** Extend `packages/mobile/lib/mobile-query-persistence.ts` and its colocated tests; add the smallest canonical pnpm patch to `expo-apple-authentication` with executable native diagnostic tests; update native runtime/build notes and dependency lock metadata as needed.

**Interfaces:** Capture storage read/remove failures at their actual boundaries and write failures through persister retry's error argument. The provider's onError has no error argument. Expose only safe error categories/codes and aggregate write byte/count measurements. Maintain a real UTF-8 byte cap. For Apple unknown authorization errors, retain allowlisted native domain/code and underlying code before Expo discards them; never include NSError userInfo or arbitrary localized descriptions. Use [pnpm's patch mechanism](https://pnpm.io/cli/patch) and preserve [Expo Apple sign-in behavior](https://docs.expo.dev/versions/latest/sdk/apple-authentication/).

- [x] Write failing tests for safe storage classification, redaction, unchanged error propagation, multibyte byte-cap boundaries, and aggregate write diagnostics.
- [x] Implement storage diagnostics and validate the focused mobile suites.
- [x] Write an executable native regression for unknown Apple NSError classification/redaction, then patch the installed pinned module using the canonical pnpm mechanism. Preserve cancellation and original unknown failure handling.
- [x] Run native tests/build validation and relevant login/auth mobile tests; document the required new native runtime/build.

**Review checkpoint:** Independent review found a missing hydration-error reporting boundary; a real-provider failing regression reproduced it, and a sanitized provider fallback closed it. Scoped re-review passed. Storage/auth/login/parser suites passed 125 tests before that refinement; the final persistence suite passed 26/26. The installed Swift helper's executable classification/redaction/retention regression passed. Prebuild, pods, and the combined generic-iOS Release archive passed with runtime 1.2. No signing, upload, physical-device validation, or production recovery is claimed.

## Completion and Review

Each task receives independent spec/quality review. Run full workspace lint, unit/mobile tests, relevant integration suites, and root/server/web/mobile typechecks before pushing the completed changes. Review the whole branch, update the incident baseline, and open a reviewable PR. Production deployment and historical projection materialization require concrete reviewed changes. Leave issues with unknown or unverified production causes unresolved.

**Final verification:** Whole-branch review approved with no blocking findings. Workspace lint and all four typechecks passed; after integrating main, unit/mobile tests passed 19,131 tests in 1,304 files (20 tests/two files skipped), and combined real ClickHouse/Redis regressions passed 21/21. The installed Swift helper executable and combined generic-iOS Release archive passed. CI identified missing Docker-free coverage for Redis exact invalidation; added unit regressions passed 20 tests, and the exact changed-range mutation command killed both mutants at 100% without changing production code or thresholds. Production rollout/materialization, runtime 1.2 device delivery, unknown cause evidence, and fresh PR CI remain separate completion gates.
