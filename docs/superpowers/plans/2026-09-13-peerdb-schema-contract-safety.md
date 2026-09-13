# PeerDB Schema Contract Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a PostgreSQL/PeerDB/ClickHouse schema mismatch from silently
blocking all later activity and sleep data, recover the current production
mirror without replacing its replication slot, and make the same failure a
required CI and deployment failure.

**Architecture:** A typed mirror contract becomes the sole source for PeerDB
table mappings and exclusions. Initial mirror SQL, live reconciliation,
catalog validation, health diagnostics, integration fixtures, and deployment
canaries all consume that contract. Destructive ClickHouse changes use a
fail-closed expand/contract sequence: reconcile the PeerDB projection while
consumers are quiesced, verify compatibility, migrate, prove a causal marker,
then resume consumers.

**Tech Stack:** TypeScript, Vitest, PostgreSQL 18, ClickHouse, PeerDB Flow API,
Docker Compose, GitHub Actions, Sentry/OpenTelemetry.

**Spec:**
[`docs/superpowers/specs/2026-09-13-peerdb-schema-contract-safety-design.md`](../specs/2026-09-13-peerdb-schema-contract-safety-design.md)

## Global Constraints

- Follow TDD: observe each focused test fail before implementing its behavior.
- Database semantics must be tested against real PostgreSQL and ClickHouse.
- PeerDB behavior must be tested against the repository's real PeerDB Compose
  overlay; module mocks cannot substitute for that tier.
- Do not increase reconciliation timeouts, retries, or stale thresholds.
- Do not recreate a healthy production mirror or logical replication slot.
- Do not resume ClickHouse consumers until contract validation and the causal
  marker canary both pass.
- Commit and push after every task. Preserve unrelated worktree changes.

---

## Task 1: Establish the canonical mirror contract

**Files:**

- Create: `src/db/peerdb/mirror-contracts.ts`
- Create: `src/db/peerdb/mirror-contracts.test.ts`
- Modify: `src/db/peerdb/metric-stream-cdc.sql`
- Modify: `src/db/clickhouse-cdc.ts`
- Modify: `src/db/clickhouse-cdc.test.ts`

- [ ] **Step 1: Write the failing contract/rendering tests**

  Assert that the contract contains every currently managed mirror and mapped
  table exactly once, assigns each processing marker to its destination, and
  defines these migration-0085 exclusions:

  ```ts
  expect(mapping("dofek_fitness_raw_analytics", "fitness.daily_metrics").exclude).toEqual([
    "recovery_high_minutes",
    "resilience_level",
    "stress_high_minutes",
  ]);
  expect(mapping("dofek_fitness_raw_analytics", "fitness.sleep_session").exclude).toEqual([
    "sleep_need_baseline_minutes",
    "sleep_need_from_debt_minutes",
    "sleep_need_from_nap_minutes",
    "sleep_need_from_strain_minutes",
  ]);
  ```

  Assert that rendering the SQL template emits all mappings from the contract,
  including exact `EXCLUDE (...)` clauses, instead of maintaining a second
  hand-written list.

- [ ] **Step 2: Run the focused tests and confirm RED**

  Run:

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-contracts.test.ts src/db/clickhouse-cdc.test.ts
  ```

  Expected: fail because the contract module and generated mapping blocks do
  not exist and the current template does not exclude migration-0085 columns.

- [ ] **Step 3: Implement the smallest typed contract and renderer**

  Define readonly mirror/table entries containing mirror name, source and
  destination identifiers, exclusions, initial-copy policy, and optional
  processing-marker metadata. Replace the table mapping bodies in
  `metric-stream-cdc.sql` with named placeholders rendered from this contract.
  Derive publication tables, destination truncation lists, managed mirror
  names, and required mappings from the same values in `clickhouse-cdc.ts`.

- [ ] **Step 4: Run focused tests and static checks**

  Run:

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-contracts.test.ts src/db/clickhouse-cdc.test.ts
  pnpm exec biome check src/db/peerdb/mirror-contracts.ts src/db/peerdb/mirror-contracts.test.ts src/db/clickhouse-cdc.ts src/db/clickhouse-cdc.test.ts
  pnpm typecheck
  ```

- [ ] **Step 5: Commit and push**

  ```bash
  git add src/db/peerdb/mirror-contracts.ts src/db/peerdb/mirror-contracts.test.ts src/db/peerdb/metric-stream-cdc.sql src/db/clickhouse-cdc.ts src/db/clickhouse-cdc.test.ts
  git commit -m "Define canonical PeerDB mirror contracts"
  git push
  ```

---

## Task 2: Add executable PostgreSQL/ClickHouse contract validation

**Files:**

- Create: `src/db/peerdb/mirror-schema-validator.ts`
- Create: `src/db/peerdb/mirror-schema-validator.test.ts`
- Create: `src/db/peerdb/mirror-schema-validator.integration.test.ts`
- Modify: `src/db/clickhouse.ts`
- Modify: `src/db/clickhouse-raw-tables.ts`
- Modify: `src/db/clickhouse-raw-tables.test.ts`
- Create: `src/db/clickhouse-migrations/0087_complete_peerdb_raw_schema.ts`
- Create: `src/db/clickhouse-migrations/0087_complete_peerdb_raw_schema.test.ts`
- Modify: `src/db/clickhouse-migrations/registry.ts`
- Modify: `src/db/clickhouse-migrations/registry.test.ts`
- Modify: `src/db/README.md`

- [ ] **Step 1: Write failing validator unit tests**

  Through the validator's production API, cover: compatible projections,
  projected source columns missing from ClickHouse, misspelled/obsolete
  exclusions, missing PeerDB metadata columns, and stable identifier-only
  diagnostics. Keep catalog clients required dependencies.

- [ ] **Step 2: Write the failing real-engine regression**

  Apply the current PostgreSQL and ClickHouse schemas, load the canonical
  contract, and assert the validator accepts the migration-0085 end state.
  In an isolated ClickHouse test database, recreate one removed projected
  column as required by the old contract and assert the old empty-exclusion
  projection fails with `stress_high_minutes` and the other removed columns in
  the structured difference.

- [ ] **Step 3: Run the focused tests and confirm RED**

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-schema-validator.test.ts
  pnpm test:integration -- src/db/peerdb/mirror-schema-validator.integration.test.ts
  ```

- [ ] **Step 4: Implement catalog readers and validator**

  Read PostgreSQL `information_schema.columns` and ClickHouse
  `system.columns`; compute `source - exclusions - destination` per mapping;
  validate `_peerdb_synced_at`, `_peerdb_is_deleted`, and `_peerdb_version`
  separately. Return a structured report and throw one deterministic error
  that contains only mirror, table, and column identifiers.

  The real-engine RED run also exposed pre-existing drift beyond migration
  0085. Explicitly exclude the retired provider energy estimates, model the
  seven already-retired source fields as exclusions that may be absent after
  the source-side contraction, and add `food_entry.nutrition_grain` plus
  `health_event.source_bundle`/`metadata` to both the ClickHouse bootstrap and
  an idempotent ClickHouse migration. The validator must then prove the full
  current contract, not a hand-selected subset.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-schema-validator.test.ts
  pnpm test:integration -- src/db/peerdb/mirror-schema-validator.integration.test.ts
  pnpm exec biome check src/db/peerdb/mirror-schema-validator.ts src/db/peerdb/mirror-schema-validator.test.ts src/db/peerdb/mirror-schema-validator.integration.test.ts
  pnpm typecheck
  ```

- [ ] **Step 6: Commit and push**

  ```bash
  git add src/db/peerdb/mirror-schema-validator.ts src/db/peerdb/mirror-schema-validator.test.ts src/db/peerdb/mirror-schema-validator.integration.test.ts src/db/peerdb/mirror-contracts.ts src/db/peerdb/mirror-contracts.test.ts src/db/clickhouse-raw-tables.ts src/db/clickhouse-raw-tables.test.ts src/db/clickhouse-migrations/0087_complete_peerdb_raw_schema.ts src/db/clickhouse-migrations/0087_complete_peerdb_raw_schema.test.ts src/db/clickhouse-migrations/registry.ts src/db/clickhouse-migrations/registry.test.ts src/db/README.md
  git commit -m "Validate PeerDB projections against database schemas"
  git push
  ```

---

## Task 3: Reconcile existing mappings with verified two-phase remaps

**Files:**

- Create: `src/db/peerdb/mirror-reconciler.ts`
- Create: `src/db/peerdb/mirror-reconciler.test.ts`
- Modify: `src/db/clickhouse-cdc.ts`
- Modify: `src/db/clickhouse-cdc.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

  Cover exact mapping equality including order-insensitive exclusions. For a
  stale `daily_metrics` mapping, require this observable API sequence:

  1. pause and wait for `STATUS_PAUSED`;
  2. send `removed_tables: ["fitness.daily_metrics"]` and keep the mirror
     paused;
  3. poll until the mapping is absent;
  4. send `additional_tables` with the canonical exclusion list and request
     `STATUS_RUNNING`;
  5. poll until the mirror is running and the exact mapping is present.

  Also cover multiple changed tables in one remove phase, missing mappings,
  already-canonical mappings, API failure, read-back mismatch, and timeout.
  Failures must leave the mirror paused rather than resuming an unverified
  projection.

- [ ] **Step 2: Run focused tests and confirm RED**

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-reconciler.test.ts src/db/clickhouse-cdc.test.ts
  ```

- [ ] **Step 3: Implement the reconciler and API shape**

  Extend `PeerDbCdcFlowConfigUpdate` with `removed_tables`; compare every live
  managed mapping with the canonical contract; execute separate verified
  remove/add transitions; and report mirror/table/exclusion drift without row
  data. Replace the special-case `requiredExistingMirrorTableMappings` path
  with full contract reconciliation.

- [ ] **Step 4: Run focused tests and checks**

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-reconciler.test.ts src/db/clickhouse-cdc.test.ts
  pnpm exec biome check src/db/peerdb/mirror-reconciler.ts src/db/peerdb/mirror-reconciler.test.ts src/db/clickhouse-cdc.ts src/db/clickhouse-cdc.test.ts
  pnpm typecheck
  ```

- [ ] **Step 5: Commit and push**

  ```bash
  git add src/db/peerdb/mirror-reconciler.ts src/db/peerdb/mirror-reconciler.test.ts src/db/clickhouse-cdc.ts src/db/clickhouse-cdc.test.ts
  git commit -m "Reconcile PeerDB mappings without replacing mirrors"
  git push
  ```

---

## Task 4: Add a real PeerDB CDC integration tier

**Files:**

- Create: `vitest.peerdb.config.ts`
- Create: `src/db/peerdb/peerdb-cdc.integration.test.ts`
- Create: `src/db/peerdb/peerdb-test-helpers.ts`
- Modify: `scripts/run-tests.ts`
- Modify: `scripts/run-tests.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/test.yml`
- Modify: `docs/testing.md`

- [ ] **Step 1: Add failing runner and CI contract tests**

  Require a `peerdb-integration` test mode that starts the base Compose stack
  plus `docker-compose.peerdb.yml` through `pnpm compose --`, waits for all
  dependencies, runs only the PeerDB integration config, and tears down only
  the workspace-scoped resources it created. Require the GitHub Actions test
  workflow to invoke that mode when PostgreSQL schema, ClickHouse schema,
  mirror contract, setup, or PeerDB Compose files change.

- [ ] **Step 2: Run runner tests and confirm RED**

  ```bash
  pnpm vitest run --project unit scripts/run-tests.test.ts .github/workflows/test.test.ts
  ```

- [ ] **Step 3: Implement the explicit test tier**

  Add `pnpm test:peerdb-integration`; keep unit and mutation projects
  Docker-free and keep the PeerDB suite out of ordinary integration shards.
  Use a dedicated Compose suffix and deterministic cleanup.

- [ ] **Step 4: Write the failing end-to-end regression**

  Create uniquely named test peers/mirrors from the production contract,
  insert minimal valid rows into `daily_metrics`, `sleep_session`, `activity`,
  and each mirror's processing-marker route, and poll ClickHouse for the exact
  marker. Include values in the removed PostgreSQL provider-derived columns so
  the test proves they are excluded rather than accidentally absent from the
  fixture. Assert the mirrors remain running and their read-back exclusions
  exactly match the contract.

- [ ] **Step 5: Run the PeerDB suite and confirm RED, then GREEN**

  ```bash
  pnpm test:peerdb-integration -- src/db/peerdb/peerdb-cdc.integration.test.ts
  ```

  First run before wiring the contract must reproduce the ClickHouse missing
  column normalization failure. After using the canonical renderer and
  reconciler, the same fixture and markers must arrive successfully.

- [ ] **Step 6: Run focused checks**

  ```bash
  pnpm vitest run --project unit scripts/run-tests.test.ts .github/workflows/test.test.ts
  pnpm exec biome check vitest.peerdb.config.ts src/db/peerdb/peerdb-cdc.integration.test.ts src/db/peerdb/peerdb-test-helpers.ts scripts/run-tests.ts scripts/run-tests.test.ts
  pnpm typecheck
  ```

- [ ] **Step 7: Commit and push**

  ```bash
  git add vitest.peerdb.config.ts src/db/peerdb/peerdb-cdc.integration.test.ts src/db/peerdb/peerdb-test-helpers.ts scripts/run-tests.ts scripts/run-tests.test.ts package.json .github/workflows/test.yml docs/testing.md
  git commit -m "Exercise PeerDB CDC against real database engines"
  git push
  ```

---

## Task 5: Add fail-closed deployment gates and causal marker canaries

**Files:**

- Create: `src/db/peerdb/mirror-deployment.ts`
- Create: `src/db/peerdb/mirror-deployment.test.ts`
- Create: `src/db/run-clickhouse-cdc-contract.ts`
- Create: `src/db/run-clickhouse-cdc-contract.test.ts`
- Modify: `entrypoint.sh`
- Modify: `entrypoint.test.ts`
- Modify: `.github/workflows/deploy-web-stack.yml`
- Modify: `.github/workflows/deploy-web-stack.test.ts`
- Modify: `deploy/README.md`

- [ ] **Step 1: Write failing orchestration tests**

  Require three explicit modes:

  - `prepare`: reconcile live mappings and validate compatibility while the old
    destination schema still exists;
  - `finalize`: rerun schema validation after migrations and write one unique
    operation/dataset/batch marker per contract flow;
  - `verify`: wait for those exact markers and source watermarks in their
    assigned ClickHouse destinations.

  Verify a failed remap, schema difference, or missing marker exits non-zero
  and prevents the workflow step that restores ClickHouse consumers.

- [ ] **Step 2: Run focused tests and confirm RED**

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-deployment.test.ts src/db/run-clickhouse-cdc-contract.test.ts entrypoint.test.ts .github/workflows/deploy-web-stack.test.ts
  ```

- [ ] **Step 3: Implement deployment orchestration**

  Reuse the existing processing-operation/marker writer rather than creating a
  second readiness protocol. Persist the generated marker identifiers in a
  root-owned temporary deploy artifact shared only by the three deployment
  steps. Do not add optional dependencies or a test-only runtime branch.

- [ ] **Step 4: Put the gates in compatibility-safe order**

  In `deploy-web-stack.yml`, after PeerDB is reachable and while consumers are
  quiesced: run `prepare`; run database migrations; run the existing CDC setup;
  run `finalize` and `verify`; only then deploy the full stack. Keep all steps
  hard-failing and preserve diagnostics for a paused mirror.

- [ ] **Step 5: Run focused checks**

  ```bash
  pnpm vitest run --project unit src/db/peerdb/mirror-deployment.test.ts src/db/run-clickhouse-cdc-contract.test.ts entrypoint.test.ts .github/workflows/deploy-web-stack.test.ts
  pnpm exec biome check src/db/peerdb/mirror-deployment.ts src/db/peerdb/mirror-deployment.test.ts src/db/run-clickhouse-cdc-contract.ts src/db/run-clickhouse-cdc-contract.test.ts .github/workflows/deploy-web-stack.test.ts
  pnpm typecheck
  ```

- [ ] **Step 6: Commit and push**

  ```bash
  git add src/db/peerdb/mirror-deployment.ts src/db/peerdb/mirror-deployment.test.ts src/db/run-clickhouse-cdc-contract.ts src/db/run-clickhouse-cdc-contract.test.ts entrypoint.sh entrypoint.test.ts .github/workflows/deploy-web-stack.yml .github/workflows/deploy-web-stack.test.ts deploy/README.md
  git commit -m "Gate deployments on PeerDB causal readiness"
  git push
  ```

---

## Task 6: Detect normalization stalls immediately and safely

**Files:**

- Modify: `src/db/clickhouse-cdc-health.ts`
- Modify: `src/db/clickhouse-cdc-health.test.ts`
- Modify: `scripts/check-clickhouse-cdc.ts`
- Modify: `scripts/check-clickhouse-cdc.test.ts`
- Modify: `docs/clickhouse-cdc-health-runbook.md`

- [ ] **Step 1: Capture the exact PeerDB failure signal before coding**

  Against the pinned PeerDB version, inspect the Flow API status payload and
  catalog metadata for the known failed mirror. Record which persisted field
  exposes normalization failure. If neither exposes it, use the authoritative
  `peerdb_stats.cdc_batches` sync/normalize cursor gap as the immediate service
  signal and keep the detailed error classification in the already-exported
  structured flow-worker log. Do not scrape container logs from application
  code and do not add an Axiom dependency to CDC correctness.

- [ ] **Step 2: Write failing health tests for the evidenced signal**

  Assert that a normalization error or a non-advancing normalize cursor with a
  newer synced batch is unhealthy on the next health run, even when the flow
  state says `running` and domain freshness has not expired. Assert emitted
  diagnostics contain only flow/table/error classification and safe parsed
  identifiers.

- [ ] **Step 3: Run focused tests and confirm RED**

  ```bash
  pnpm vitest run --project unit src/db/clickhouse-cdc-health.test.ts scripts/check-clickhouse-cdc.test.ts
  ```

- [ ] **Step 4: Implement and document the health classification**

  Keep slot state, retained WAL, mirror catalog state, normalization progress,
  and table freshness as separate issue kinds. Continue reporting unexpected
  query/runtime failures to Sentry through the existing checker.

- [ ] **Step 5: Run focused checks**

  ```bash
  pnpm vitest run --project unit src/db/clickhouse-cdc-health.test.ts scripts/check-clickhouse-cdc.test.ts
  pnpm exec biome check src/db/clickhouse-cdc-health.ts src/db/clickhouse-cdc-health.test.ts scripts/check-clickhouse-cdc.ts scripts/check-clickhouse-cdc.test.ts
  pnpm typecheck
  ```

- [ ] **Step 6: Commit and push**

  ```bash
  git add src/db/clickhouse-cdc-health.ts src/db/clickhouse-cdc-health.test.ts scripts/check-clickhouse-cdc.ts scripts/check-clickhouse-cdc.test.ts docs/clickhouse-cdc-health-runbook.md
  git commit -m "Detect stalled PeerDB normalization promptly"
  git push
  ```

---

## Task 7: Complete repository validation and document the incident

**Files:**

- Modify: `docs/production-incident-baseline.md`
- Modify: `docs/processing-status-runbook.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Document diagnosis and durable response**

  Append the 2026-09-13 incident with symptoms, user impact, exact first fatal
  line (`No such column stress_high_minutes in table
  postgres_fitness.daily_metrics`), causal chain, direct contract fix,
  validation status, production recovery status, and remaining risk. Add the
  new contract-check/canary procedure to the operator runbook with links to
  PeerDB's official create, edit, state-change, schema-change, and resync docs.

- [ ] **Step 2: Run the complete required local gates**

  ```bash
  pnpm lint
  pnpm typecheck
  pnpm test:all
  pnpm test:peerdb-integration
  git diff --check
  ```

  Do not claim success from stale output. Capture each command's fresh exit
  status. If Docker disk pressure blocks the database tiers, follow
  `docs/testing.md` and remove only this workspace's disposable resources and
  rebuildable cache.

- [ ] **Step 3: Commit and push**

  ```bash
  git add docs/production-incident-baseline.md docs/processing-status-runbook.md docs/README.md
  git commit -m "Document PeerDB schema mismatch prevention"
  git push
  ```

---

## Task 8: Review, ship, recover production, and verify user impact

**Files:** No new implementation files expected.

- [ ] **Step 1: Run the requesting-code-review workflow**

  Review the complete diff against the approved design, with particular focus
  on data preservation, pause-state failure behavior, deployment ordering,
  integration-test isolation, and whether every consumer of mirror mappings
  uses the canonical contract. Fix validated findings with tests and push each
  follow-up commit.

- [ ] **Step 2: Run the ship-pr workflow**

  Re-run pre-push checks, open or update the pull request, and monitor all CI
  checks through completion. Do not merge or deploy while any required check is
  failing.

- [ ] **Step 3: Deploy through the normal production workflow**

  The deployment must use the new `prepare`/migration/`finalize`/`verify`
  sequence. For the current incident, confirm it removes and re-adds only the
  `daily_metrics` and `sleep_session` mappings with their exact exclusions,
  retains the existing mirror and active reserved replication slot, and does
  not truncate unrelated destinations.

- [ ] **Step 4: Validate recovery with fresh evidence**

  Require all of the following without ad-hoc waits:

  - the exact causal marker reaches
    `postgres_fitness.processing_flow_marker`;
  - PeerDB normalization and sync cursors advance and the retained WAL backlog
    drains;
  - `activity`, `sleep_session`, and dependent read-model freshness advance;
  - the failed durable operation is superseded by a successful recompute;
  - the web/mobile activity queries return current activities and the sleep and
    body queries return current results;
  - CDC health reports healthy with no new missing-column normalization error.

- [ ] **Step 5: Update the incident entry with final production evidence**

  Record the deployed commit, validation timestamps, retained-slot evidence,
  user-visible recovery, and any remaining risk. Commit and push the final
  documentation update.
