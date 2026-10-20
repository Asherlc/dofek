# Primary Activity Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user chooses delegated execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the closest available activity record using provenance alone and show its actual provider's logo on activity cards.

**Architecture:** Keep existing field representatives and value selection intact; resolve primary identity separately from current group members. dbt computes ClickHouse attribution, the legacy ClickHouse activity view becomes a thin projection over that result, and PostgreSQL implements equivalent provenance semantics. Preserve raw Apple Health source-app identifiers and expose explicit resolved/unresolved attribution to web and mobile.

**Tech Stack:** TypeScript, PostgreSQL views, ClickHouse/dbt, Zod, React, React Native, Vitest, Storybook. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-primary-activity-origin-design.md`

## Global Constraints

- The primary activity is the record Dofek actually holds that is closest to the original user-initiated recording.
- Assume one original user-initiated recording per existing activity group.
- Origin selection uses provenance only. Provider, device, field, and sensor priorities do not participate.
- Individual activity fields and sensor values retain their existing selection rules.
- Activity group identity and grouping behavior remain unchanged.
- Use a 20 px provider logo in the card header on web and mobile.
- Unsupported labels remain unresolved; there is no blanket Garmin > Strava > Apple Health ranking.
- Do not deploy or run a production historical refresh. Do not switch branches without explicit approval.

## Review Focus

- Source-app bundle and display name disagree: report conflicting evidence, never select using priority (Tasks 1–3).
- Multiple same-provider records match a source label: do not manufacture an individual-record relationship (Tasks 1–3).
- Source removal, revision replacement, or a late-arriving original: recompute attribution without changing group IDs or losing field data (Tasks 2–3).
- Unresolved primary is null: preserve activity visibility, account-erasure coverage, and API validity (Tasks 2–4).
- Legacy view no longer derives representatives directly: match the dbt row and preserve its documented active-row/member contract (Task 2).

## File and Interface Map

- `packages/providers-meta/src/activity-origin.ts`: shared API types and runtime schema; no provider priority inputs.
- `src/test-fixtures/activity-origin.json`: synthetic provenance cases consumed by both database behavior suites. Each case contains `members`, `expectedPrimaryMemberId`, and `expectedCandidateMemberIds`.
- `analytics/macros/activity_origin.sql`: ClickHouse provenance CTEs over current members, with `user_id`, `group_id`, `activity_id`, `provider_id`, `source_name`, and `raw` inputs.
- `analytics/models/read_models/deduped_activities.sql`: preserve existing field representative and join independent provenance selection.
- `drizzle/_views/01_v_activity.sql`: preserve PostgreSQL field representative and add equivalent provenance resolution.
- `packages/server/src/models/activity-source-decision.ts`: explanations and projection of the independent origin result.
- Web card: `packages/web/src/components/ActivityCardContent.tsx`.
- Mobile activities card: `packages/mobile/app/(tabs)/activities.tsx`; this screen renders cards inline and does not use the separate strain-screen `ActivityCard` component.

### Task 1: Preserve and define provenance evidence

**Files:** Modify `packages/server/src/routers/health-kit-sync-processors.ts`, its colocated tests, `packages/server/src/routers/health-kit-sync.integration.test.ts`; create `packages/providers-meta/src/activity-origin.ts`, its test, and `src/test-fixtures/activity-origin.json`; update the shared package exports and README.

**Interfaces:** Export `activityOriginSchema` and inferred `ActivityOrigin`, a discriminated union: `{ status: 'resolved'; memberActivityId: string; providerId: string; sourceName: string | null } | { status: 'unresolved'; candidateMemberActivityIds: string[] }`. Export `ActivityOriginEvidence` with `upstreamMemberActivityId`, `downstreamMemberActivityId`, `field`, and `value`; these describe actual evidence, not inferred provider quality.

- [ ] Add failing ingestion assertions that workout `raw.sourceBundle` retains the exact uploaded value, including `com.strava.strava`, while existing raw fields and workout identity remain unchanged.
- [ ] Add schema tests that reject resolved attribution with missing IDs and accept unresolved attribution without an invented provider. Validate fixture input at runtime.
- [ ] Add shared fixture cases for all three approved Garmin → Strava → Apple Health availability examples; singleton; no provenance; unknown source; duplicate provider candidates; cycle; conflicting source bundle/name; a direct Strava recording with an unrelated Garmin member; and a non-ASCII/case-varied source name.
- [ ] Run `pnpm exec vitest run --project unit packages/server/src/routers/health-kit-sync-processors.test.ts packages/providers-meta/src/activity-origin.test.ts`; confirm the new preservation assertion fails before implementation.
- [ ] Preserve `workout.sourceBundle` in `rawData`, implement the union schema using the existing Zod dependency, expose its package subpath, and document the provenance contract.
- [ ] Re-run the targeted tests; require all new cases to pass. Preserve fixture coverage for database execution in Tasks 2 and 3.
- [ ] Review the diff and commit this coherent ingestion/contract change after the required checks. Push only after the repository's pre-push checks pass.

### Task 2: Resolve ClickHouse primary identity independently

**Files:** Create `analytics/macros/activity_origin.sql`, `src/db/activity-origin-read-model.integration.test.ts`, `src/db/clickhouse-migrations/0104_activity_origin.ts` and its tests; modify `analytics/models/read_models/deduped_activities.sql`, `src/db/clickhouse-read-models.ts`, migration registry, existing representative behavior suites, and `analytics/README.md`.

**Interfaces:** Persist `representative_activity_id UUID` for the previous field representative; change `primary_activity_id` to `Nullable(UUID)` for actual origin; add `primary_provider_id Nullable(String)`, `primary_source_name Nullable(String)`, `origin_candidate_member_ids Array(UUID)`, and `origin_evidence Array(Map(String,String))`. Primary is resolved exactly when its ID/provider are non-null. Keep existing `provider_id` and merged values on their current field-selection semantics.

- [ ] Add executable fixture-driven tests against the dbt model. Assert exact primary IDs/provider IDs and unresolved candidate IDs. Run the supported integration command to establish the pre-change failures; if Docker is unavailable under the cloud instructions, record the execution limitation and retain tests for CI.
- [ ] Add a regression that snapshots every served activity value except attribution metadata, then changes only provenance and asserts exact value equality and the same group ID. Separately change field priority/sensor contribution and assert primary identity is unchanged.
- [ ] Add lifecycle tests for upstream arrival, removal, Apple Health revision replacement, unchanged second build, and conflicting evidence; assert correct refresh-version changes only when served content changes.
- [ ] Implement provider-specific evidence in the macro. Recognize Apple Health source-app names with exact normalized known-provider labels; use retained source bundle IDs only for verified mappings. Initial recording-device evidence is limited to the fixture-backed `Garmin Edge` and `Wahoo ELEMNT` device families on Strava records. Require a unique matching available member; where both records supply device names, require compatible names. Unknown labels, ambiguous matches, and contradictory claims cannot produce a resolved primary.
- [ ] Resolve directed upstream-to-copy reachability within a group. Select a primary only for a singleton or one member that reaches every candidate, with no cycle or conflicting evidence. Terminate closure after at most the member count; do not impose a fixed transfer-chain length. Store the supporting evidence fields/values.
- [ ] Preserve the existing `best` calculation as the field representative and join origin separately. Extend incremental row comparison, current/existing projections, and tombstones for all new columns. Do not feed origin back into type, modality, names, notes, time context, raw-field selection, sensor samples, or location provider selection.
- [ ] Add the idempotent serving-schema migration and bootstrap definitions. Existing rows must initially have unresolved origin, rather than inheriting the old priority-selected member as a proven primary. Keep the old representative ID in `representative_activity_id` for compatibility with field semantics.
- [ ] Replace the legacy `analytics.v_activity` derivation with a thin active-row projection over `analytics.deduped_activities`, keeping legacy column names and the stable group ID contract. Update `v_activity_members` and executable view tests to consume the materialized result; do not add a second provenance algorithm in TypeScript.
- [ ] Update ClickHouse fixtures/bootstrap tables and tests that previously assumed every primary was non-null. Preserve assertions about field representatives under the new name rather than deleting them.
- [ ] Run targeted integration suites, `pnpm lint:analytics-policy`, and `pnpm lint:analytics-sql` when the required environment is available. Static SQL tests supplement executable tests; they do not replace them.
- [ ] Review the diff and commit with passing supported checks; follow repository pre-push requirements.

### Task 3: Match PostgreSQL origin semantics

**Files:** Modify `drizzle/_views/01_v_activity.sql`; create `drizzle/0152_activity_origin.sql` and `src/db/activity-origin.integration.test.ts`; update `drizzle/meta/_journal.json`, `src/db/README.md`, representative integration assertions, and account-erasure attribution where required.

**Interfaces:** PostgreSQL exposes the same `representative_activity_id`, nullable `primary_activity_id`, `primary_provider_id`, `primary_source_name`, candidate IDs, and evidence semantics as Task 2. Existing fields, provider attribution used for field selection, and group IDs remain intact.

- [ ] Execute the Task 1 fixture matrix through PostgreSQL and assert the same selected member/provider or unresolved candidates as ClickHouse. Add a cross-group/user case proving evidence cannot cross those boundaries.
- [ ] Add exact before/after field-value assertions, independent priority changes, missing raw metadata, duplicate provider candidates, source conflicts, and removal/revision cases. Confirm the pre-change view fails the new origin assertions.
- [ ] Extend the existing view using provenance edges and cycle-safe recursive reachability. Preserve every existing field selector and source lifecycle filter. Use new SQL functions only if needed to keep the view maintainable; do not persist derived origin in raw Postgres activity rows.
- [ ] Migrate the old representative column name safely: PostgreSQL does not permit arbitrary output-column renames through `CREATE OR REPLACE VIEW`. Update dependent views using an explicit migration sequence, then restore their stable member/group contracts. Do not modify previously applied migrations.
- [ ] Update the account-erasure manifest to include any newly exposed UUID columns and arrays; assert null primaries do not skip related group members.
- [ ] Run `pnpm test:integration -- src/db/activity-origin.integration.test.ts` and relevant existing field/group/erasure suites when available. Apply migrations to the local test database; never claim execution when local database services are unavailable.
- [ ] Update database documentation with code references and review/commit after supported checks.

### Task 4: Expose truthful source attribution

**Files:** Modify `packages/server/src/models/activity-source-decision.ts`, `packages/server/src/repositories/activity-calendar-entry.ts`, `packages/server/src/repositories/activities-calendar-repository.ts`, relevant activity-detail projections, their tests, and calendar test helpers. Audit `buildActivitySourceDecision` callers and existing source text.

**Interfaces:** Add `origin: ActivityOrigin` to `ActivityListSourceDetail` and `ActivitySourceDecisionDetail`. `buildActivityListSource` and `buildActivitySourceDecision` accept the typed origin alongside existing contributing links. Existing selected-field provider input is not a default primary.

- [ ] Add failing projection tests for a field representative differing from primary, unresolved origin, singleton downstream record, and an Apple Health record whose source app differs from its actual provider. Assert a missing Garmin record never yields a Garmin primary logo/provider.
- [ ] Extend SQL projections and Zod boundary schemas to parse all origin columns and produce the Task 1 union. A null primary yields unresolved attribution without dropping the activity, fields, metrics, or contributing source links.
- [ ] Replace the old non-null `primarySourceLabel` contract with a nullable label derived only from resolved origin. Source counts continue counting contributing records, independent of origin resolution. Update both clients' source types and callers atomically.
- [ ] Use exact explanation copy: resolved multi-source, `"{provider} is the closest available record to the original recording. Individual details may come from other matched sources."`; unresolved, `"The available source information does not establish which record is closest to the original recording."`. Do not claim that source priority chose the primary.
- [ ] Update activity detail, calendar, and MCP consumers that expose primary identity so unresolved attribution remains explicit. Verify primary provider labels use the actual record provider; source-app labels remain separate provenance details.
- [ ] Run the affected unit tests via `pnpm exec vitest run --project unit` with the changed test paths, plus server typechecking. Review/commit after supported checks.

### Task 5: Render the logo on web and mobile activity cards

**Files:** Modify `packages/web/src/components/ActivityCardContent.tsx`, its test and stories, web activity-page fixtures; `packages/mobile/app/(tabs)/activities.tsx`, `packages/mobile/app-tests/(tabs)/activities.test.tsx`, `packages/mobile/app-stories/(tabs)/activities.stories.tsx`, and mobile activity fixtures. Reuse the existing platform `ProviderLogo` components.

**Interfaces:** Cards consume `activity.source.origin`. Resolved attribution supplies `providerId` to `ProviderLogo` at size `20`; unresolved attribution renders no primary-provider logo. Mobile uses the existing server URL configuration for assets.

- [ ] Add failing tests that Garmin/Strava/Apple Health are displayed only for their respective selected available records, unresolved origin has no logo, and field representative changes cannot change the logo.
- [ ] Add tests for accessible provider names, a long activity title, selection mode, map/no-map layout, and a provider without an image asset. Preserve card navigation and selection behavior.
- [ ] Place the logo in the header's top-right area, preserving the activity icon and title. Provide the accessible label on the wrapper because existing `ProviderLogo` images are decorative. Keep SVG providers' existing mobile letter fallback; do not add an unrelated SVG rendering dependency.
- [ ] Update colocated web and route-level mobile stories for resolved, unresolved, singleton, missing-logo, long-title, and selection-mode variants. Do not place helpers, tests, or stories inside the Expo routes directory.
- [ ] Run the targeted web unit and mobile tests using their configured Vitest projects, and typecheck both clients. Inspect stories if the environment supports browser execution; record any visual-verification limitation.
- [ ] Review/commit after supported checks.

### Task 6: Verify the complete change and document release

**Files:** Update `analytics/README.md`, `src/db/README.md`, `packages/web/README.md`, `packages/mobile/README.md`, and `docs/clickhouse-read-model-deploy-runbook.md` only where the new behavior changes their current contracts.

**Interfaces:** No new runtime interfaces. Release documentation names the serving migration, dbt dependency order, required bounded refresh, and unresolved legacy state before refresh.

- [ ] Verify both databases with the same fixture matrix and complete the full invariance test: provenance-only changes may change origin metadata and lifecycle version, but never merged values or group IDs.
- [ ] Check all `primary_activity_id`, `primarySourceLabel`, and `selected by source priority` references. Correct primary consumers and retain representative-specific assertions under the accurate name.
- [ ] Run `git diff --check`, relevant unit/mobile suites, `pnpm lint`, all required package typechecks, analytics policy/SQL checks, and executable integration suites where available. Use `mise run test:sandbox` in the documented Docker-free cloud environment; report the integration limitation explicitly if applicable.
- [ ] Document the release sequence: schema migrations first, compatible readers/writers, then the established explicitly bounded dbt refresh. No production deployment or refresh is authorized by this plan.
- [ ] Perform final code review under the chosen execution workflow, resolve findings, and report changes, actual test results, unresolved limitations, and a short retrospective. Suggest documentation improvements only when the work reveals a concrete gap.

## Execution Notes

The design is approved. Implementation begins after the user reviews this plan
and chooses native or delegated execution, as required by the planning workflow.
Native execution is recommended because the database schemas and both client
contracts change together and a single implementer can maintain that context.

Before execution, recheck migration numbers `0103` and `0151` against the current
branch, and follow the worktree skill without switching branches absent user
approval. Preserve the current clean product-code state and these design drafts.

Primary-source API documentation could not be reached through the configured
proxy during design. Use the retained-code fixtures for existing semantics;
new bundle/device mappings require verification before they become origin rules.
