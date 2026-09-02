# Activity Data Integrity Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make activity groups, local-time context, sensor-summary hydration, and MCP power reporting trustworthy for new and historically stored activities.

**Architecture:** Preserve raw provider activities and sensor samples. Compute duplicate edges solely from immutable raw activity facts, form connected components once, and only then consume compatible member summaries. A dry-run-first, CAS-guarded repair command snapshots the prior state and writes newer ClickHouse versions for both repair and rollback.

**Tech Stack:** TypeScript, Vitest, Drizzle/Postgres, ClickHouse `ReplacingMergeTree`, dbt, Zod.

**Spec:** `docs/superpowers/specs/2026-09-02-activity-data-integrity-repair-design.md`

## Global Constraints

- Raw provider identities, payloads, and sensor samples are immutable; repair only derived local-time fields and read-model rows.
- No blended power aggregate is served. `power_by_modality` has `indoor`, `outdoor`, and `unknown` strata, each with `n >= 3` gating.
- All unavailable numeric observations serialize as `null`; zero means a measured zero.
- Repair commands are TypeScript, default to dry-run, require an explicit UTC window and `--execute`, are user-scoped, bounded, idempotent, and compare-and-swap guarded.
- Read `ReplacingMergeTree` verification state with `FINAL`; rollback writes captured values with a newer version.
- Before a later historical repair starts, the earlier repair artifact must be accepted and retired by the named production operator within the recorded deadline.

---

## File structure

- `packages/format/src/record-local-time.ts`: canonical fixed-zone and offset consistency resolver.
- `src/db/provider-activity-sync.ts`: forward provider activity normalization.
- `analytics/models/read_models/activity_duplicate_matches.sql`: raw-fact duplicate-edge predicate.
- `packages/server/src/repositories/activity-repository.ts`: compatible summary hydration.
- `packages/server/src/mcp/tools.ts`: modality-stratified power contract.
- `src/db/activity-data-integrity-repair.ts`: bounded repair and rollback domain service.
- `scripts/repair-activity-data-integrity.ts`: CLI parser and production execution boundary.
- `scripts/inspect-activity-data-integrity.ts`: read-only diagnosis for speed, Strong, and HR provenance.
- `docs/activity-data-integrity-repair-runbook.md`: operator procedure, acceptance owner, deadline, and artifact retirement.

### Task 1: Establish read-only diagnosis evidence

**Files:**
- Create: `scripts/inspect-activity-data-integrity.ts`
- Create: `scripts/inspect-activity-data-integrity.test.ts`

**Produces:** `inspectActivityDataIntegrity(db, { userId, activityIds })`, returning selected summary member IDs, their provider/type, Strong parent/set evidence, and source heart-rate samples.

- [ ] **Step 1: Write failing tests for the two speed hypotheses and Strong parentage**

```ts
expect(parseInspectionArgs(["--user-id=u", "--activity-id=2a", "--activity-id=761"]))
  .toEqual({ userId: "u", activityIds: ["2a", "761"] });
expect(result.activities[0]).toMatchObject({ selectedSummaryActivityId: "peloton-member" });
expect(result.strongSessions).toEqual(expect.arrayContaining([
  expect.objectContaining({ activityId: "369e6444", setCount: 0 }),
]));
```

- [ ] **Step 2: Run the focused test and verify it fails because the parser/service does not exist**

Run: `pnpm vitest run scripts/inspect-activity-data-integrity.test.ts`

- [ ] **Step 3: Implement the bounded read-only query service and CLI**

```ts
export async function inspectActivityDataIntegrity(
  db: SchemaExecutionDatabase,
  input: { userId: string; activityIds: string[] },
) {
  // Query fitness.v_activity, analytics.activity_sensor_summary_rows FINAL,
  // and fitness.strength_set by the supplied IDs only; emit no UPDATE/INSERT.
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm vitest run scripts/inspect-activity-data-integrity.test.ts`

- [ ] **Step 5: Run the production read-only inspection before continuing**

Run: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/inspect-activity-data-integrity.ts --user-id=<authorized-user-id> --activity-id=2a7c6fa3 --activity-id=761483e6 --activity-id=6ca753f3 --activity-id=369e6444`

Expected: report the selected summary member for each Wahoo ride, both Strong activity/set parentages, exact name bytes, and the source record for walking HR 189. Stop if credentials, IDs, or evidence are unavailable.

- [ ] **Step 6: Commit**

```bash
git add scripts/inspect-activity-data-integrity.ts scripts/inspect-activity-data-integrity.test.ts
git commit -m "Add activity integrity inspection"
```

### Task 2: Make local-time contexts internally consistent

**Files:**
- Modify: `packages/format/src/record-local-time.ts`
- Modify: `packages/format/src/record-local-time.test.ts`
- Modify: `src/db/provider-activity-sync.ts`
- Modify: `src/db/provider-activity-sync.test.ts`

**Produces:** `resolveProviderTimezoneLocalTimeContext({ startedAt, endedAt, timezone })` returning a geographic timezone context or an offset-only fixed-zone context.

- [ ] **Step 1: Write failing fixed-zone and contradictory-offset tests**

```ts
expect(resolveProviderTimezoneLocalTimeContext({
  startedAt: new Date("2026-09-01T14:55:54Z"), timezone: "Etc/GMT+4",
})).toEqual({ timezone: null, startUtcOffsetMinutes: -240, endUtcOffsetMinutes: null, source: "provider_offset" });
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run packages/format/src/record-local-time.test.ts src/db/provider-activity-sync.test.ts`

- [ ] **Step 3: Implement the resolver and route Peloton inserts through it**

```ts
if (isFixedEtcGmtZone(timezone)) {
  return resolveRecordLocalTimeContext({ startedAt, endedAt, startUtcOffsetMinutes: offsetInTimezone(startedAt, timezone), endUtcOffsetMinutes: endedAt ? offsetInTimezone(endedAt, timezone) : null, source: "provider_offset" });
}
```

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run packages/format/src/record-local-time.test.ts src/db/provider-activity-sync.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/format/src/record-local-time.ts packages/format/src/record-local-time.test.ts src/db/provider-activity-sync.ts src/db/provider-activity-sync.test.ts
git commit -m "Normalize fixed activity timezones"
```

### Task 3: Correct duplicate edges and prevent incompatible hydration

**Files:**
- Modify: `analytics/models/read_models/activity_duplicate_matches.sql`
- Modify: `analytics/models/read_models/activity_duplicate_matches.integration.test.ts`
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Modify: `packages/server/src/repositories/activity-repository.test.ts`

**Produces:** raw-edge components that cannot join unrelated Wahoo/Peloton activities, plus `selectCompatibleActivitySummary(row, summaries)`.

- [ ] **Step 1: Write failing integration and repository tests**

```ts
expect(groupsFor("2a7c6fa3")).not.toContain("peloton-member");
expect(selectCompatibleActivitySummary(cyclingRow, summaries)?.activity_id).toBe("wahoo-member");
expect(selectCompatibleActivitySummary(runningRow, pelotonOnlySummaries)).toBeNull();
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm test:integration -- analytics/models/read_models/activity_duplicate_matches.integration.test.ts && pnpm vitest run packages/server/src/repositories/activity-repository.test.ts`

- [ ] **Step 3: Implement raw-fact-only matching and compatible hydration**

```ts
function summaryCompatibleWithActivity(row: ActivityRow, member: ActivityMember): boolean {
  return member.canonical_type === row.canonical_type &&
    (member.canonical_type !== "other" || member.provider_id === row.provider_id);
}
```

Keep the SQL edge predicate independent of `group_id`; connected components are built from all current edges in one model run.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm test:integration -- analytics/models/read_models/activity_duplicate_matches.integration.test.ts && pnpm vitest run packages/server/src/repositories/activity-repository.test.ts`

- [ ] **Step 5: Commit**

```bash
git add analytics/models/read_models/activity_duplicate_matches.sql analytics/models/read_models/activity_duplicate_matches.integration.test.ts packages/server/src/repositories/activity-repository.ts packages/server/src/repositories/activity-repository.test.ts
git commit -m "Prevent incompatible activity summary hydration"
```

### Task 4: Publish modality-stratified power truthfully

**Files:**
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `packages/server/src/mcp/tools.test.ts` (create if absent)

**Produces:** `power_by_modality` with `avg_power`, `max_power_peak`, and `{ activities_with_power, activities_total, pct }` per stratum.

- [ ] **Step 1: Write failing MCP tests for three-observation gating and provenance before gating**

```ts
expect(summary.power_by_modality.indoor).toEqual({ avg_power: 190, max_power_peak: 320, activities_with_power: 3, activities_total: 3, pct: 100 });
expect(summary.power_by_modality.outdoor.avg_power).toBeNull();
expect(runningSummary.preGatePowerMemberProviderIds).not.toContain("peloton");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run packages/server/src/mcp/route.test.ts`

- [ ] **Step 3: Implement per-modality aggregation**

```ts
const modalities = ["indoor", "outdoor", "unknown"] as const;
const powerByModality = Object.fromEntries(modalities.map((modality) => [
  modality, summarizePower(groupRows.filter((row) => (row.modality ?? "unknown") === modality)),
]));
```

`summarizePower` returns null aggregates below three powered activities while retaining coverage.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run packages/server/src/mcp/route.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts packages/server/src/mcp/tools.test.ts
git commit -m "Stratify activity power by modality"
```

### Task 5: Preserve null elevation and trace HR/Strong findings

**Files:**
- Modify: `analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts`
- Modify: `packages/server/src/mcp/route.test.ts`
- Modify: `src/providers/strong-csv.ts` and `src/providers/strong-csv.test.ts` only if Task 1 proves an import identity defect.
- Modify: the source identified by Task 1 for HR 189 only if its raw sample is invalid or mislinked.

- [ ] **Step 1: Add failing missing-elevation and observed-defect tests**

```ts
expect(kayakingSummary.total_elevation_gain_m).toBeNull();
expect(otherSummary.power_by_modality.unknown.max_power_peak).toBeNull();
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm vitest run analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts packages/server/src/mcp/route.test.ts`

- [ ] **Step 3: Apply only the source-proven fix selected by Task 1**

If Strong sets are misattached, derive its external ID from normalized workout timestamp plus normalized name; if absent, repair the parser that discarded the set. If HR 189 is raw and valid, retain it; if cross-linked, fix the linking key. Do not add a physiological threshold.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts packages/server/src/mcp/route.test.ts src/providers/strong-csv.test.ts`

- [ ] **Step 5: Commit**

```bash
git add analytics/models/read_models/activity_sensor_summary_rows.sql.test.ts packages/server/src/mcp/route.test.ts src/providers/strong-csv.ts src/providers/strong-csv.test.ts
git commit -m "Preserve missing activity measurements"
```

### Task 6: Build the auditable historical repair and rollback

**Files:**
- Create: `src/db/activity-data-integrity-repair.ts`
- Create: `src/db/activity-data-integrity-repair.test.ts`
- Create: `scripts/repair-activity-data-integrity.ts`
- Create: `scripts/repair-activity-data-integrity.test.ts`
- Create: `docs/activity-data-integrity-repair-runbook.md`

**Produces:** `repairActivityDataIntegrity(db, clickhouse, options)` and `rollbackActivityDataIntegrity(db, clickhouse, artifactPath)`.

- [ ] **Step 1: Write failing dry-run, fixpoint, CAS, idempotence, rollback-version, and artifact-retirement tests**

```ts
expect(await repairActivityDataIntegrity(db, client, { execute: false, userId, startAt, endAt })).toMatchObject({ updated: 0, artifactPath: expect.any(String) });
await expect(rollbackActivityDataIntegrity(db, client, artifactPath)).rejects.toThrow("stale audit artifact");
expect(insertedRollback.refresh_version).toBeGreaterThan(repaired.refresh_version);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm vitest run src/db/activity-data-integrity-repair.test.ts scripts/repair-activity-data-integrity.test.ts`

- [ ] **Step 3: Implement bounded snapshot, CAS repair, and monotonic rollback**

```ts
export interface ActivityIntegrityRepairOptions {
  userId: string; startAt: Date; endAt: Date; execute: boolean; batchSize: number; maxBatches: number;
}
```

Persist a JSON artifact containing prior Postgres fields, affected component membership, repair run ID, and highest derived version. Read and verify ClickHouse rows with `FINAL`; rollback inserts captured values with `greatest(capturedVersion + 1, currentVersion + 1)`.

- [ ] **Step 4: Add and run real-engine integration coverage**

Run: `pnpm test:integration -- src/db/activity-data-integrity-repair.integration.test.ts`

Expected: a Wahoo/Peloton false group splits, `2a7c6fa3` loses Peloton, `894ce621` is internally consistent, and a `FINAL` query observes only the latest repair/rollback row.

- [ ] **Step 5: Write the runbook with explicit acceptance ownership**

Document: dry run; pre-write snapshot; execute; `FINAL` verification; named operator and acceptance deadline; artifact retirement; and the rule that Strong/speed repair cannot begin while this artifact remains rollback-eligible.

- [ ] **Step 6: Commit**

```bash
git add src/db/activity-data-integrity-repair.ts src/db/activity-data-integrity-repair.test.ts scripts/repair-activity-data-integrity.ts scripts/repair-activity-data-integrity.test.ts docs/activity-data-integrity-repair-runbook.md
git commit -m "Add auditable activity integrity repair"
```

### Task 7: Full verification and production acceptance

**Files:**
- Modify: `docs/production-incident-baseline.md`

- [ ] **Step 1: Run static and targeted checks**

Run: `pnpm lint:analytics-policy && pnpm typecheck && pnpm test:changed:all`

- [ ] **Step 2: Run the approved production dry run and inspect its artifact**

Run: `pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/repair-activity-data-integrity.ts --user-id=<authorized-user-id> --start-at=<UTC> --end-at=<UTC>`

Expected: no writes, exact candidate/change counts, audit artifact, and a declared resolution for the speed and Strong diagnosis.

- [ ] **Step 3: Obtain explicit approval for the production `--execute` run**

Do not execute without a user-provided target user/window approval after dry-run evidence.

- [ ] **Step 4: Verify the observed MCP outcomes with `FINAL` read-model state**

Assert: Wahoo/Peloton split; `894ce621` context consistency; null low-count power in `other`; no inherited 423 W on running; null kayaking elevation; and record the expected unknown-modality limitation and possible unclassified-rate increase.

- [ ] **Step 5: Append incident baseline and commit**

```bash
git add docs/production-incident-baseline.md
git commit -m "Document activity integrity repair"
```
