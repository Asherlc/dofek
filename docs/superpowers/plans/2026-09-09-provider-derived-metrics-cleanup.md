# Provider-Derived Metrics Cleanup Implementation Plan

Status: Implemented and validated on 2026-09-09.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent provider-computed scores, thresholds, recommendations, and classifications from entering canonical Health Data storage.

**Architecture:** Provider syncs will retain raw observations and raw activity provenance, while server/ClickHouse analytics continue to compute derived metrics from those observations. The migration removes the dedicated Oura stress/resilience and WHOOP sleep-need columns; provider APIs that only supply those computed values or sleep recommendations will no longer be fetched or persisted.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL/TimescaleDB, ClickHouse/dbt, Vitest, Biome.

**Spec:** The user-approved audit rule: thresholds and other derived metrics must be computed from actual stored observations, not provider-supplied estimates or scores.

## Global Constraints

- Store raw observations and provider provenance only; do not store provider-computed thresholds, scores, recommendations, or classifications.
- Keep metric computation server-side.
- Preserve provider independence and avoid provider-specific fields in shared canonical tables.
- Write repository automation in TypeScript and run it with `pnpm tsx`.
- Use TDD: each behavior change gets a failing test before production code changes.
- Do not change the existing `paseo.json` user file.

---

### Task 1: Add a failing canonical-write policy check

**Files:**
- Create: `scripts/provider-derived-metric-policy.ts`
- Create: `scripts/provider-derived-metric-policy.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `findProviderDerivedMetricViolations(source: string, fileName: string): string[]` for the CLI and unit test.
- The CLI scans provider/server ingestion source files and exits non-zero with file and line details when forbidden canonical-write patterns are present.

- [ ] **Step 1: Write the failing test**

Test that a canonical assignment such as `stressHighMinutes: parsed.stressHighMinutes` and `stress: sample.stressLevel` is rejected, while `raw: { trainingStressScore: value }` is not rejected.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run scripts/provider-derived-metric-policy.test.ts`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement the policy and CLI**

Define explicit forbidden canonical patterns for provider threshold observations, Oura stress/resilience/cardio-age writes, WHOOP sleep-need writes, provider stress-channel writes, and provider expenditure-energy writes. Scan only ingestion source directories, not tests or raw payload object literals.

- [ ] **Step 4: Run the focused test and policy scan**

Run: `pnpm vitest run scripts/provider-derived-metric-policy.test.ts`

Expected: the fixture assertions pass and the repository scan reports the currently known violations.

- [ ] **Step 5: Add the policy to lint**

Add `pnpm provider-derived-metric-policy` to `lint:sandbox` after the existing source-policy checks.

### Task 2: Remove Oura computed-score ingestion

**Files:**
- Modify: `src/providers/oura/client.ts`
- Modify: `src/providers/oura/schemas.ts`
- Modify: `src/providers/oura/parsing.ts`
- Modify: `src/providers/oura/sync-steps.ts`
- Modify: `src/providers/oura/provider.ts`
- Modify: `src/providers/oura.test.ts`
- Modify: `src/providers/oura-sync.integration.test.ts`

**Interfaces:**
- Oura sync retains sleep-derived HRV/resting HR, activity observations, SpO₂, and raw sleep/activity records.
- Oura no longer fetches or stores readiness score, VO₂ max, daily stress, resilience, or cardiovascular age.

- [ ] **Step 1: Update Oura tests to cover the allowed observation set**

Remove tests that assert deleted provider-score persistence and retain tests asserting HRV, resting HR, steps, and SpO₂ are synchronized.

- [ ] **Step 2: Run Oura tests and verify the intended failures**

Run: `pnpm vitest run src/providers/oura.test.ts src/providers/oura-sync.integration.test.ts`

Expected: existing score-persistence assertions fail against the desired new contract.

- [ ] **Step 3: Remove computed endpoint fetches and writes**

Delete Oura score/resilience/stress/cardio-age sync calls, webhook branches, schemas/client methods, composite fetches, parser fields, health-event writes, and daily-metric writes. Keep generic health-event support for unrelated raw health events.

- [ ] **Step 4: Run Oura tests**

Run: `pnpm vitest run src/providers/oura.test.ts src/providers/oura-sync.integration.test.ts`

Expected: PASS.

### Task 3: Remove WHOOP sleep-need persistence

**Files:**
- Modify: `src/providers/whoop/parsing.ts`
- Modify: `src/providers/whoop/sync-sleep.ts`
- Modify: `src/providers/whoop/sync-helpers.test.ts`
- Modify: `src/providers/whoop-parsing.test.ts`
- Modify: `src/providers/whoop-sync.integration.test.ts`

**Interfaces:**
- WHOOP sleep persistence retains session boundaries and sleep-stage observations.
- WHOOP provider-computed baseline/debt/strain/nap sleep-need components are not represented in parsed canonical rows.

- [ ] **Step 1: Remove assertions for provider sleep-need fields from existing tests**

Keep tests for timestamps, stages, duration, and provider biometric observations.

- [ ] **Step 2: Run the focused WHOOP tests and verify failures**

Run: `pnpm vitest run src/providers/whoop-parsing.test.ts src/providers/whoop-sync.integration.test.ts src/providers/whoop/sync-helpers.test.ts`

Expected: tests fail only where they still expect provider sleep-need fields.

- [ ] **Step 3: Remove sleep-need fields from parsing and persistence**

Delete the parsed properties and both insert/update assignments while leaving the raw provider response available to the activity/session provenance path where it already exists.

- [ ] **Step 4: Run the focused WHOOP tests**

Run: `pnpm vitest run src/providers/whoop-parsing.test.ts src/providers/whoop-sync.integration.test.ts src/providers/whoop/sync-helpers.test.ts`

Expected: PASS.

### Task 4: Remove provider stress writes from Garmin and Zepp ingestion

**Files:**
- Modify: `src/providers/garmin/sync-orchestrator.ts`
- Modify: `src/providers/garmin/sync-step-plan.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.ts`
- Modify: `packages/zepp/src/background-health.ts`
- Modify: `packages/zepp/src/background-health-storage.ts`
- Modify: `packages/zepp/src/health-collector.ts`
- Modify: `packages/zepp/src/background-health.test.ts`
- Modify: `packages/zepp/src/background-health-storage.test.ts`
- Modify: `packages/zepp/src/health-collector.test.ts`

**Interfaces:**
- Garmin and Zepp continue uploading raw heart rate, SpO₂, and temperature observations.
- Provider stress indices are not collected into or written to `metric_stream`/`daily_metrics`.

- [ ] **Step 1: Update provider tests to cover retained raw observations**

Remove stress-specific expectations and keep the existing heart-rate, SpO₂, temperature, and activity expectations.

- [ ] **Step 2: Run focused provider tests and verify failures**

Run: `pnpm vitest run src/providers/garmin packages/zepp/src`

Expected: failures identify stress collection/write expectations.

- [ ] **Step 3: Remove stress collection, transport fields, sync planning, and canonical writes**

Remove the Garmin stress sync step and the Zepp stress fields/sensor reads. Do not remove the unrelated subjective breathwork `stressBefore`/`stressAfter` fields.

- [ ] **Step 4: Run focused provider tests**

Run: `pnpm vitest run src/providers/garmin packages/zepp/src`

Expected: PASS.

### Task 5: Remove obsolete canonical columns and clean existing rows

**Files:**
- Create: `drizzle/0074_remove_provider_derived_metrics.sql`
- Modify: `src/db/schema/activity.ts`
- Modify: `src/db/clickhouse-raw-tables.ts`
- Modify: `packages/nutrition/src/daily-metrics.ts`
- Modify: `packages/server/src/routes/ingest-zos-health.ts`

**Interfaces:**
- PostgreSQL and ClickHouse raw mirrors no longer expose dedicated Oura stress/resilience or WHOOP sleep-need columns.
- The migration deletes existing values before dropping those columns and removes the associated daily-metric catalog rows and Oura health-event rows.

- [ ] **Step 1: Add schema/migration regression coverage**

Extend the existing migration/schema integration coverage to assert the final tables no longer contain the removed columns after migration.

- [ ] **Step 2: Run the new migration test and verify it fails**

Run: `pnpm vitest run src/db/daily-metrics-schema.integration.test.ts`

Expected: FAIL against the current schema.

- [ ] **Step 3: Update PostgreSQL/ClickHouse schemas and migration**

Drop `stress_high_minutes`, `recovery_high_minutes`, `resilience_level`, `sleep_need_baseline_minutes`, `sleep_need_from_debt_minutes`, `sleep_need_from_strain_minutes`, and `sleep_need_from_nap_minutes`; delete their existing rows/catalog entries and Oura computed health events before the drops.

- [ ] **Step 4: Run schema verification**

Run: `pnpm vitest run src/db/daily-metrics-schema.integration.test.ts`

Expected: PASS when the database test dependencies are available.

### Task 6: Full verification and push

**Files:**
- Modify only files required by Tasks 1–5.

- [ ] **Step 1: Run focused unit/provider tests**

Run: `pnpm test:changed`

Expected: PASS with no new failures.

- [ ] **Step 2: Run typecheck and lint policies**

Run: `pnpm typecheck` and `pnpm lint`

Expected: exit 0.

- [ ] **Step 3: Review the diff and repository state**

Run: `git diff --check`, `git status --short`, and `git diff --stat`.

Expected: only the planned source, test, migration, and policy files are changed; pre-existing `paseo.json` remains untouched.

- [ ] **Step 4: Commit and push**

Run: `git add <planned files>`, `git commit -m "Remove provider-derived metric writes"`, and `git push -u origin review-zwift-fcp-storage`.

Expected: the commit is present on the current branch and the remote push succeeds.
