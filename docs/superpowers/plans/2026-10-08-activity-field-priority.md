# Activity Field Source Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select each merged activity field from the source with the best configured priority, starting with Kaya's climbing name.

**Architecture:** Store provider and field priority rows in Postgres, mirror them to ClickHouse, and apply the same field-specific override over the existing generic source priority in each activity merge. Keep canonical identity and type selection independent of display fields. The server already supplies the merged name to web and mobile.

**Tech Stack:** TypeScript, Drizzle migrations, PostgreSQL, PeerDB, ClickHouse, dbt, Vitest.

**Spec:** [Activity Field Source Priority Design](../specs/2026-10-08-activity-field-priority-design.md)

## Global Constraints

- The table is `fitness.provider_field_priority(provider_id text, field_key text, priority integer)` with primary key `(provider_id, field_key)`; smaller priority wins.
- Wire `activity.name` and `activity.notes` in all activity merge paths, and `activity.perceived_exertion` in the Postgres projection where it exists. Only Kaya's `activity.name` gets a seeded override, priority `0`.
- For each non-null candidate, use `COALESCE(field_priority, existing_device_priority, existing_provider_priority, 100)`, then source activity ID for ties. Do not apply a field override to canonical provider/type, sensor fields, or raw JSON keys.
- Extend the existing `provider_priority_audit` table and trigger with `field_key`; keep source activity rows unchanged.
- Use real PostgreSQL and ClickHouse integration tests for merge behavior, and the workspace Compose wrapper for local dependencies. Do not test static config files in isolation.
- Do not remove the `Cardio:` prefix globally. No new dependency, environment variable, client metric calculation, or web/mobile view change is required.
- Each new commit is pushed to the remote branch. Do not switch branches.

## Review Focus

- A source with a configured field rule but a null value must be skipped; the next non-null source supplies that field (Tasks 1–3).
- A field rule must override a generic device priority for only that field; other fields retain their generic ordering (Tasks 1–3).
- Equal effective priorities must choose the lowest source activity ID in every merge path (Tasks 1–3).
- A tombstoned or deleted priority row in the ClickHouse mirror must fall back to generic priority (Tasks 2–3).
- An unrelated activity with no field rule must keep its prior selected name and canonical type (Tasks 1–3, allowing the documented dbt correction of canonical-member name selection).

---

### Task 1: PostgreSQL rule, audit, and canonical activity view

**Files:**
- Create: `src/db/activity-field-priority.integration.test.ts`
- Create: `drizzle/0144_activity_field_source_priorities.sql`
- Modify: `src/db/schema/reference.ts`, `drizzle/meta/_journal.json`, `drizzle/_views/01_v_activity.sql`

**Interfaces:**
- Produces: `fitness.provider_field_priority(provider_id, field_key, priority)` and a `field_key` column in `fitness.provider_priority_audit`.
- Produces: unchanged public columns in `fitness.v_activity`, with field-specific ranking for `name`, `notes`, and `perceived_exertion`.

- [ ] **Step 1: Write the failing name regression test.** In a migrated test database, seed one persisted group with WHOOP and Apple Health climbing members with null names, Peloton cardio member named `41 min 58 sec Cardio: Climbing`, and Kaya climbing member named `Kaya climbing at Touchstone Great Western Power Company`. Query `fitness.v_activity` and assert `name` is Kaya's, `canonical_type` is `climbing`, `provider_id` is WHOOP, and `member_activity_ids` contains all four source IDs. Assert the raw Peloton activity still has its original name.
- [ ] **Step 2: Run the test and record RED.** Run `rtk pnpm test:integration -- src/db/activity-field-priority.integration.test.ts`; expected failure: selected name is Peloton's title.
- [ ] **Step 3: Add the table, seed, and name rule.** Add the Drizzle model, the migration and journal entry, and matching changes to the canonical view file. In the migration create the table, seed `('kaya', 'activity.name', 0)`, then replace the view without changing its column order or types. Rank non-null names by `COALESCE(field_rule.priority, r.prio), r.id`.
- [ ] **Step 4: Run the name regression test and record GREEN.** Same command; expected: the merged name is Kaya's and canonical metadata is unchanged.
- [ ] **Step 5: Write the failing independent-field tests.** Insert a second provider's `activity.notes` rule, plus an `activity.perceived_exertion` rule, in separate groups. Assert each field changes source independently while the other displayed fields and canonical metadata stay put. Cover null preferred values, generic device fallback, equal-priority ID ties, and an unrelated activity without a rule. The mutation that omits either field-specific ranking must fail a named assertion.
- [ ] **Step 6: Run those tests and record RED, then wire the remaining Postgres fields.** The expected initial failure is a selected notes or exertion value from the generic source. Add the two rule joins or lookups and keep the raw JSON merge on `r.prio`.
- [ ] **Step 7: Add and test the audit extension.** First assert inserting, updating, and deleting a field rule creates audit rows with `priority_table = 'provider_field_priority'`; observe RED because no trigger records them. Extend the audit column, constraint, function, and trigger, and place those migration statements before the Kaya seed so the seed is audited. Then assert `field_key` and old/new JSON values and rerun GREEN. Keep the test in the same integration file.
- [ ] **Step 8: Verify and commit.** Run `rtk pnpm test:integration -- src/db/activity-field-priority.integration.test.ts`, `rtk pnpm lint:migrations`, and `rtk uv tool run sqlfluff lint drizzle/0144_activity_field_source_priorities.sql`; expect all pass. Compare the migration's final view definition against `drizzle/_views/01_v_activity.sql`, then commit and `rtk git push`.

### Task 2: ClickHouse mirror and live activity view

**Files:**
- Create: `src/db/clickhouse-migrations/0102_activity_field_source_priorities.ts`
- Create: `src/db/activity-field-priority-read-model.integration.test.ts`
- Modify: `src/db/clickhouse-raw-tables.ts`, `src/db/peerdb/mirror-contracts.ts`, `src/db/clickhouse-read-models.ts`, `src/db/clickhouse-migrations/registry.ts`
- Modify fixture: `src/db/clickhouse-migrations/0081_stable_activity_read_views.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's `(provider_id, field_key, priority)` rows through `postgres_fitness.provider_field_priority FINAL` with `_peerdb_is_deleted = 0`.
- Produces: raw mirror table keyed by `(provider_id, field_key)` and unchanged public columns in `analytics.v_activity`, with field-priority ranking for `name` and `notes`.

- [ ] **Step 1: Write a real ClickHouse RED fixture.** Create an isolated database with activity, generic priority, device priority, and field priority raw tables. Insert the four climbing source records and the Kaya name rule. Apply the current live view builder. Assert Kaya's name, WHOOP's canonical identity/type, and generic note selection; before the code change, the view returns Peloton's name.
- [ ] **Step 2: Run RED.** Run `rtk pnpm test:integration -- src/db/activity-field-priority-read-model.integration.test.ts`; expected failure: live view name remains Peloton's.
- [ ] **Step 3: Implement mirror and view.** Add the raw table definition and PeerDB mapping. Register migration `0102` as `pre-cdc`: create the raw table before refreshing `analytics.v_activity` and its dependent members view using `buildActivityReadModelRefreshStatements()`. Join active field rules by `(provider_id, field_key)` and rank non-null `name` and `notes` with `tuple(effective_priority, toString(activity_id))`. Preserve the generic priority for canonical selection and raw JSON.
- [ ] **Step 4: Run GREEN and extend the fixture.** Verify the four-source case; then test null Kaya name, another field rule for notes, device priority fallback, equal-priority ID ties, deleted mirrored rule, and an unrelated group. Expect each field to change independently and the deleted rule to restore generic ordering. Update the existing `0081` integration fixture to create the newly required raw priority table.
- [ ] **Step 5: Verify and commit.** Run the new and `0081` integration files, `rtk pnpm test:integration -- src/db/peerdb/mirror-schema-validator.integration.test.ts`, `rtk pnpm typecheck`, and `rtk pnpm lint:analytics-policy`; expect all pass. Then commit and `rtk git push`.

### Task 3: dbt activity merge and downstream refresh

**Files:**
- Create: `src/db/activity-field-priority-dbt.integration.test.ts`
- Modify: `analytics/models/sources.yml`, `analytics/models/read_models/deduped_activities.sql`
- Modify fixtures as required: existing integration tests that render `deduped_activities.sql` with isolated ClickHouse tables, especially `src/db/activity-group-payload-union.integration.test.ts`

**Interfaces:**
- Consumes: Task 2's mirrored field priority rows and existing `activity_source_records.priority` generic ranking.
- Produces: unchanged `deduped_activities` columns, selecting `name` and `notes` from non-null source members by `(effective_priority, activity_id)`; downstream `activity_summary_rows` reads the new name through its existing refresh watermark.

- [ ] **Step 1: Write a real ClickHouse RED fixture for the dbt SQL.** Use `readModelSql` and `renderDbtModelSql` with an isolated minimal set of raw activity, source-record, sensor, field-priority, and output tables. Seed a group where WHOOP is canonical, Peloton has the generic-priority name, and Kaya has the field-priority name. Assert Kaya's name, WHOOP's canonical metadata, and an independent generic note; the current dbt model selects the canonical member's name.
- [ ] **Step 2: Run RED.** Run `rtk pnpm test:integration -- src/db/activity-field-priority-dbt.integration.test.ts`; expected failure: dbt merged name is null or the canonical member's name, rather than Kaya's.
- [ ] **Step 3: Implement the dbt rule.** Declare the new raw source in `sources.yml`. Join active field rules to ranked source records for `activity.name` and `activity.notes`, and use `argMinIf` with `(effective_priority, activity_id)` for non-null values. Keep canonical member choice, source payload merge, and existing output columns unchanged. Align no-rule name selection with the Postgres and live ClickHouse generic order, as the approved spec requires.
- [ ] **Step 4: Run GREEN and cover refresh behavior.** Test the null preferred name, note-specific rule, generic device fallback, ID ties, deleted rule, and unrelated activity. Run an incremental second pass after changing the priority row; assert `deduped_activities FINAL` gets the new name and later `activity_summary_rows FINAL` gets the same name through the existing dirty-key watermark. Update isolated render fixtures to provide the new raw table.
- [ ] **Step 5: Verify and commit.** Run the new fixture and affected existing integration files, `rtk pnpm analytics:build`, `rtk pnpm lint:analytics-sql`, `rtk pnpm lint:analytics-policy`, `rtk pnpm typecheck`, and `rtk pnpm test`. Expect all pass; commit and `rtk git push`.

## Completion checks

- Run `rtk pnpm test:integration` after the focused suites to catch other consumers of the activity view and model; investigate named failures rather than weakening tests.
- Run `rtk git diff --check` and inspect the full branch diff against `origin/main` for scope, raw-data preservation, and consistent priority fallback.
- After deployment and CDC catch-up, run the existing analytics build and compare activity `f7a00878-9b01-4436-968c-d86c6a8b7fc9` in Postgres, ClickHouse, and the API. The selected name should be `Kaya climbing at Touchstone Great Western Power Company` and the type should remain `climbing`.
