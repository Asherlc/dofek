# Repeated Effort Identity and Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-agnostic repeated-effort identity, route/workout equivalence discovery, comparison, and trend analysis to Dofek MCP with provenance-rich cycling metrics.

**Architecture:** Store source-member identity evidence in an incremental ClickHouse/dbt model, aggregate it through stable canonical activity groups, and store only durable user-defined benchmark assertions in Postgres. Materialize bounded route identity in dbt, share the existing server-side cycling metric calculations, and expose discovery, comparison, and trend tools through focused repositories and strict Zod wire schemas.

**Tech Stack:** TypeScript, Drizzle/Postgres, ClickHouse, dbt incremental models, Vitest, MCP SDK, Zod, `executeWithSchema`.

**Spec:** `docs/superpowers/specs/2026-09-10-repeated-effort-identity-design.md`

## Global Constraints

- `fitness.activity.external_id` remains the provider-instance identifier; reusable workout, route, segment, test, and benchmark identities use distinct kinds.
- Identity evidence is retained at source-member level and projected through stable canonical activity groups.
- Exact and strongly inferred equivalence are discoverable by default; weak name/duration similarity is opt-in and never exact.
- Expensive GPS normalization and comparison are incremental ClickHouse/dbt work; request paths remain bounded.
- Missing, estimated, calculated, interpolated, inferred, and conflicting values remain explicitly labeled.
- Historical ordinary-workout best powers are descriptive lower bounds, not physiological maxima; lower recent observations do not establish decline.
- All raw SQL results use Zod schemas and `executeWithSchema` or the typed ClickHouse store.
- Deploy migrations are schema-only; historical identity work is a bounded, idempotent TypeScript operator script.
- Do not add provider-specific fields to generic food or unrelated canonical tables.
- Do not read raw `ingest.metric_stream` for activity analytics; use deduplicated ClickHouse models.
- New dbt serving models are incremental and use domain/grain names without `_summary`, `_aggregate`, `_read_model`, `_table`, or `_model` suffixes.
- Unit tests are colocated `*.test.ts`; database behavior uses executable `*.integration.test.ts` tests without module-level mocks.
- New repository automation is TypeScript and runs with `pnpm tsx`.
- No HTTP development server is needed for this backend/MCP change.

## Test Fixture Contracts

The snippets below use test-local helpers so each test remains focused on one
production behavior. Each helper is defined in the test file that first uses
it; none is added to production code or exported solely for testing.

- `insertActivityGroupFixture(db, userId, activityGroupId)` inserts one valid
  user and canonical activity group and returns the inserted group row.
- `seedActivitySourceRecords(client, database, records)`,
  `seedNamedActivities(client, database, names)`, and
  `seedRouteIdentityFixture(client, database, fixture)` create isolated
  ClickHouse source/member/location fixtures.
- `buildModel(client, database, modelName)` renders the selected checked-in
  dbt model into the test database using the same helper used by neighboring
  read-model integration tests.
- `readIdentityRows(client, database, groupId)`,
  `readIdentityStrengths(client, database, normalizedValue)`, and
  `readRouteIdentity(client, database, activityId)` execute typed SELECTs and
  return the model rows under test.
- `routePoints`, `unrelatedPoints`, `fixtureSamples`, and `fixtureContext` are
  constants declared in their respective test files with valid timestamps,
  coordinates, sensors, and threshold context.
- `mergeComparableIntervals(input)`, `inferIntervalResult(input)`, and
  `calculateCyclingEffortMetrics(samples, context)` are public production
  functions produced by Tasks 1, 5, and 6 respectively.
- `repository`, `callTool(name, input)`, `mockCompare`,
  `countIdentityRows(db, userId)`, and `formatRepeatedCyclingReport(input)` are
  test-local instances/mocks or public functions defined by the task being
  tested.

---

### Task 1: Define reusable effort identity types and deterministic matching primitives

**Files:**
- Create: `packages/server/src/repositories/repeated-effort-types.ts`
- Create: `packages/server/src/repositories/repeated-effort-identity.ts`
- Create: `packages/server/src/repositories/repeated-effort-identity.test.ts`
- Create: `packages/server/src/repositories/route-equivalence.ts`
- Create: `packages/server/src/repositories/route-equivalence.test.ts`

**Interfaces:**
- Produces `EffortIdentityKind`, `EquivalenceStrength`, `EffortIdentityEvidence`, `RepeatedEffortKey`, and `RouteMatchEvidence` for all later repositories and MCP schemas.
- Produces `normalizeIdentityValue(value: string): string`, `identityKey(input): string`, `rankEquivalenceStrength(left, right): number`, `compareRepeatedEffortKeys(left, right): number`, and `evaluateRouteMatch(input): RouteMatchEvidence | null`.
- Produces `sourceActivityInstanceKey(input: { provider: string; externalId: string }): string` for provenance-only provider activity instances; this key is never a repeated-effort group key.
- Route matching accepts bounded normalized route points and returns overlap, direction, distance difference, start/end tolerance, elevation similarity, confidence, and rejection reasons without deciding whether caller assertion overrides the result.

- [ ] **Step 1: Write the failing identity vocabulary tests.**

```ts
it("keeps provider workout instances separate from reusable workout identities", () => {
  expect(identityKey({
    kind: "provider_workout",
    namespace: "peloton",
    value: "class-123",
  })).toBe("provider_workout:peloton:class-123");
  expect(sourceActivityInstanceKey({ provider: "peloton", externalId: "workout-999" }))
    .toBe("provider_activity_instance:peloton:workout-999");
  expect(sourceActivityInstanceKey({ provider: "peloton", externalId: "workout-999" }))
    .not.toBe(identityKey({ kind: "provider_workout", namespace: "peloton", value: "workout-999" }));
});

it("normalizes only whitespace and case for name evidence", () => {
  expect(normalizeIdentityValue("  FTP   Test ")).toBe("ftp test");
});

it("ranks exact above strong inferred above caller asserted above weak", () => {
  expect(rankEquivalenceStrength("exact", "strong_inferred")).toBeGreaterThan(0);
  expect(rankEquivalenceStrength("strong_inferred", "caller_asserted")).toBeGreaterThan(0);
  expect(rankEquivalenceStrength("caller_asserted", "weak_similarity")).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the focused test and verify the expected missing-symbol failure.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/repeated-effort-identity.test.ts packages/server/src/repositories/route-equivalence.test.ts --project unit`

Expected: FAIL because the new identity types/functions do not exist.

- [ ] **Step 3: Implement the minimal discriminated types and normalization functions.**

```ts
export type EffortIdentityKind =
  | "provider_workout"
  | "provider_route"
  | "canonical_route"
  | "climb"
  | "segment"
  | "standardized_test"
  | "activity_name"
  | "user_defined_benchmark";

export type EquivalenceStrength =
  | "exact"
  | "strong_inferred"
  | "caller_asserted"
  | "weak_similarity";

export function normalizeIdentityValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
```

Implement route acceptance with the spec thresholds: overlap `>= 0.9`, start/end tolerance `<= 250`, distance difference `<= 0.1`, and elevation similarity `>= 0.85` when both elevation profiles exist. Return `null` for incomplete geometry rather than creating an inferred match.

- [ ] **Step 4: Run the focused tests and verify they pass.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/repeated-effort-identity.test.ts packages/server/src/repositories/route-equivalence.test.ts --project unit`

Expected: PASS with all identity ranking, normalization, direction, threshold, and rejection cases passing.

- [ ] **Step 5: Commit the domain primitives.**

```bash
rtk git add packages/server/src/repositories/repeated-effort-types.ts packages/server/src/repositories/repeated-effort-identity.ts packages/server/src/repositories/repeated-effort-identity.test.ts packages/server/src/repositories/route-equivalence.ts packages/server/src/repositories/route-equivalence.test.ts
rtk git commit -m "feat: define repeated effort identity primitives"
rtk git push
```

### Task 2: Add durable user-defined benchmark assertions

**Files:**
- Modify: `src/db/schema/activity.ts` near `activityGroup` and `activityInterval`
- Modify: `src/db/drizzle-schema.ts` if the schema barrel requires explicit exports
- Create: `drizzle/0118_effort_equivalence_groups.sql`
- Modify: `drizzle/meta/_journal.json` through `rtk pnpm generate`
- Modify: `docs/schema.dbml` and `docs/schema.puml` through the schema-diagram script
- Create: `src/db/effort-equivalence-groups.integration.test.ts`

**Interfaces:**
- Produces `effortEquivalenceGroup` and `effortEquivalenceGroupMember` Drizzle tables.
- Group members reference `(user_id, activity_group.id)` so a benchmark follows the stable canonical activity identity and cannot attach to an obsolete source member.
- `effort_kind` is constrained to `user_defined_benchmark`; membership is an assertion and never changes activity deduplication.

- [ ] **Step 1: Write the failing schema integration test.**

```ts
it("stores a user-defined benchmark against a canonical activity group", async () => {
  const group = await insertActivityGroupFixture(db, userId, activityGroupId);
  const [benchmark] = await db.insert(effortEquivalenceGroup).values({
    userId,
    name: "Saturday benchmark",
    effortKind: "user_defined_benchmark",
  }).returning();

  await db.insert(effortEquivalenceGroupMember).values({
    groupId: benchmark.id,
    userId,
    canonicalActivityId: group.id,
  });

  expect(benchmark.id).toMatch(/[0-9a-f-]{36}/);
});
```

- [ ] **Step 2: Run the integration test and verify it fails because the tables are absent.**

Run: `rtk pnpm test:integration -- src/db/effort-equivalence-groups.integration.test.ts`

Expected: FAIL with a missing-table or missing-schema-symbol error.

- [ ] **Step 3: Add the Drizzle tables and forward-only migration.**

Add UUID primary keys, user foreign keys, `display_name`, `effort_kind`, `notes`, timestamps, composite user/group foreign keys for membership, unique `(user_id, group_id, canonical_activity_id)`, and indexes for user lookup and canonical activity lookup. Use `CREATE TABLE IF NOT EXISTS` only where existing migration conventions require idempotent deployment replay; do not backfill membership in the migration.

- [ ] **Step 4: Generate diagrams and run the focused integration test.**

Run: `rtk pnpm generate` and then `rtk pnpm test:integration -- src/db/effort-equivalence-groups.integration.test.ts`

Expected: migration, schema generation, and the benchmark membership test pass.

- [ ] **Step 5: Verify migration policy and commit.**

Run: `rtk pnpm lint:migrations`

Expected: the new migration is accepted as schema-only.

```bash
rtk git add src/db/schema/activity.ts src/db/drizzle-schema.ts drizzle/0118_effort_equivalence_groups.sql drizzle/meta/_journal.json docs/schema.dbml docs/schema.puml src/db/effort-equivalence-groups.integration.test.ts
rtk git commit -m "feat: persist user effort equivalence groups"
rtk git push
```

### Task 3: Materialize source identity evidence through canonical groups

**Files:**
- Create: `analytics/models/read_models/activity_effort_identity.sql`
- Create: `src/db/activity-effort-identity-read-model.integration.test.ts`
- Create: `src/db/activity-effort-identity-read-model.test.ts`
- Modify: `analytics/README.md` in the activity/read-model inventory section
- Modify: `analytics/models/read_models/deduped_activities.sql` only if a dependency/dirty-key column is required

**Interfaces:**
- Produces current rows at `(user_id, source_activity_id, kind, namespace, normalized_value, source_field)` grain with canonical group ID, exact/weak strength, method, and raw evidence.
- Reads `activity_source_records FINAL` and `deduped_activity_members FINAL`; never drops a member identity because another member is the representative.
- Extracts only explicitly classified raw fields: provider workout/template/class IDs, provider route/course IDs, segment IDs, and standardized-test IDs. Source `external_id` remains available as provider-instance evidence but is never emitted as reusable identity.

- [ ] **Step 1: Add executable fixture tests for identity extraction.**

```ts
it("emits two source identities for one canonical group", async () => {
  await seedActivitySourceRecords(client, database, [
    { groupId, activityId: stravaActivityId, providerId: "strava", externalId: "instance-1", raw: { routeId: "route-7" } },
    { groupId, activityId: pelotonActivityId, providerId: "peloton", externalId: "instance-2", raw: { pelotonClassId: "class-9" } },
  ]);
  await buildModel(client, database, "activity_effort_identity");

  expect(await readIdentityRows(client, database, groupId)).toEqual([
    expect.objectContaining({ kind: "provider_route", value: "route-7", strength: "exact" }),
    expect.objectContaining({ kind: "provider_workout", value: "class-9", strength: "exact" }),
  ]);
});

it("does not turn equal names into exact reusable identities", async () => {
  await seedNamedActivities(client, database, ["FTP Test", "FTP Test"]);
  await buildModel(client, database, "activity_effort_identity");
  expect(await readIdentityStrengths(client, database, "ftp test")).toEqual(["weak_similarity", "weak_similarity"]);
});
```

- [ ] **Step 2: Run the model test and verify it fails because the model is absent.**

Run: `rtk pnpm test:integration -- src/db/activity-effort-identity-read-model.integration.test.ts`

Expected: FAIL because `analytics.activity_effort_identity` is not defined.

- [ ] **Step 3: Implement the incremental dbt model.**

Use `ReplacingMergeTree(refresh_version)`, a stable order key containing user/source identity fields, current source records, canonical group/member mapping, explicit raw-field extraction, and tombstone rows for deleted/absent source records. Keep evidence as bounded JSON maps containing the raw field and source record. Add a source refresh watermark so late raw updates rebuild the affected identity rows.

- [ ] **Step 4: Run the executable ClickHouse test and analytics policy checks.**

Run: `rtk pnpm test:integration -- src/db/activity-effort-identity-read-model.integration.test.ts && rtk pnpm lint:analytics-sql && rtk pnpm lint:analytics-policy`

Expected: the fixture proves multi-provider evidence survives canonical grouping, name matches remain weak, and the model passes incremental/policy validation.

- [ ] **Step 5: Update analytics documentation and commit.**

Document the model’s source grain, explicit field mapping, tombstone behavior, and canonical-group projection in `analytics/README.md` with links to dbt incremental documentation and the MCP spec.

```bash
rtk git add analytics/models/read_models/activity_effort_identity.sql analytics/README.md src/db/activity-effort-identity-read-model.integration.test.ts src/db/activity-effort-identity-read-model.test.ts
rtk git commit -m "feat: materialize activity effort identities"
rtk git push
```

### Task 4: Materialize route fingerprints and geometry evidence

**Files:**
- Create: `analytics/models/read_models/activity_route_identity.sql`
- Create: `src/db/activity-route-identity-read-model.integration.test.ts`
- Modify: `packages/server/src/repositories/route-equivalence.ts`
- Modify: `packages/server/src/repositories/route-equivalence.test.ts`
- Modify: `analytics/README.md` with route refresh and threshold documentation

**Interfaces:**
- Produces one current route row per canonical cycling activity with provider route IDs, normalized fingerprint, direction, points, distance, start/end, bounded elevation profile, coverage, gaps, providers, and devices.
- Reads `analytics.activity_location_sample FINAL` and source identity evidence; route points are deduplicated location data, never raw `ingest.metric_stream`.
- Geometry matching returns Level B only when the spec thresholds pass and returns all route evidence fields for accepted matches.

- [ ] **Step 1: Write route model fixture tests for exact, inferred, and rejected routes.**

```ts
it("groups the same provider route ID as exact", async () => {
  await seedRouteIdentityFixture(client, database, {
    provider: "ridewithgps",
    raw: { routeId: "rw-42" },
    points: routePoints,
  });
  await buildModel(client, database, "activity_route_identity");
  expect(await readRouteIdentity(client, database, activityId)).toMatchObject({
    explicit_provider_route_ids: [{ provider: "ridewithgps", value: "rw-42" }],
  });
});

it("does not accept a route below overlap or endpoint thresholds", () => {
  expect(evaluateRouteMatch({ left: routePoints, right: unrelatedPoints })).toBeNull();
});
```

- [ ] **Step 2: Run the route integration test and verify it fails because the model is absent.**

Run: `rtk pnpm test:integration -- src/db/activity-route-identity-read-model.integration.test.ts`

Expected: FAIL because the route serving model does not exist.

- [ ] **Step 3: Implement bounded route normalization in dbt.**

Downsample each current canonical route to a bounded ordered polyline, quantize coordinates consistently, calculate a direction-preserving fingerprint and reverse fingerprint, and retain route distance/start/end/elevation profile and quality. Keep explicit provider route identities separate from geometry-derived identities. Use incremental dirty keys from activity/location refresh timestamps and emit tombstones when geometry disappears.

- [ ] **Step 4: Implement and test route comparison evidence.**

Return `direction: forward | reverse | unknown`, overlap percentage, distance difference, elevation-profile similarity, start/end tolerance, confidence, and a reason when an otherwise similar route is rejected. Add tests for forward, reverse, high-confidence geometry, missing elevation, partial points, and similar-but-different routes.

- [ ] **Step 5: Run full route validation and commit.**

Run: `rtk pnpm test:integration -- src/db/activity-route-identity-read-model.integration.test.ts && rtk pnpm lint:analytics-sql && rtk pnpm lint:analytics-policy`

Expected: executable ClickHouse behavior tests pass and analytics policy remains clean.

```bash
rtk git add analytics/models/read_models/activity_route_identity.sql analytics/README.md src/db/activity-route-identity-read-model.integration.test.ts packages/server/src/repositories/route-equivalence.ts packages/server/src/repositories/route-equivalence.test.ts
rtk git commit -m "feat: materialize repeated route identity"
rtk git push
```

### Task 5: Preserve provider-neutral structured intervals and source precedence

**Files:**
- Modify: `src/db/schema/activity.ts` in `activityInterval`
- Create: `drizzle/0119_provider_neutral_activity_intervals.sql`
- Modify: `drizzle/meta/_journal.json` through `rtk pnpm generate`
- Modify: `packages/server/src/repositories/intervals-repository.ts`
- Modify: `packages/server/src/repositories/cycling-training-metrics-repository.ts`
- Modify: `packages/server/src/mcp/cycling-training-metrics-output.ts`
- Create: `src/db/activity-intervals.integration.test.ts`
- Create: `packages/server/src/repositories/interval-source.test.ts`

**Interfaces:**
- Adds nullable `source_kind`, `source_provider`, `source_activity_id`, `segment_type`, `target_intensity`, `target_zone`, `target_cadence_rpm`, `target_power_watts`, `target_resistance`, `work_recovery_kind`, and `raw` fields.
- Provider-recorded intervals take precedence over inferred intervals for the same normalized boundary; exact duplicate boundaries retain all source member IDs.
- Inferred intervals never contain invented targets or completion percentages.

- [ ] **Step 1: Write failing precedence and schema tests.**

```ts
it("prefers provider-recorded targets over inferred boundaries", () => {
  const result = mergeComparableIntervals([
    { source: "inferred", start: 0, end: 300, targetPower: null },
    { source: "provider_recorded", start: 0, end: 300, targetPower: 240 },
  ]);
  expect(result).toMatchObject({ source: "provider_recorded", targetPower: 240 });
});

it("does not invent target or completion values for inferred intervals", () => {
  expect(inferIntervalResult({ start: 0, end: 300 })).toMatchObject({
    targetPower: null,
    completionPct: null,
  });
});
```

- [ ] **Step 2: Run unit and integration tests to verify the missing fields/functions fail.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/interval-source.test.ts --project unit && rtk pnpm test:integration -- src/db/activity-intervals.integration.test.ts`

Expected: FAIL because the normalized interval source fields and precedence helper are absent.

- [ ] **Step 3: Add schema fields and the forward-only migration.**

Keep the migration schema-only and preserve existing rows as `provider_recorded` only when their current source metadata proves that classification; otherwise leave source metadata nullable and let the reader report unknown rather than guessing.

- [ ] **Step 4: Update interval readers and cycling output.**

Expose target intensity, zone, cadence, power, resistance, work/recovery classification, source member IDs, actual sample-derived metrics, drift/decoupling, and coverage. Reuse the existing recorded/inferred interval detection rather than adding a second interval detector.

- [ ] **Step 5: Run generation, tests, migration policy, and commit.**

Run: `rtk pnpm generate && rtk pnpm exec vitest run packages/server/src/repositories/interval-source.test.ts --project unit && rtk pnpm test:integration -- src/db/activity-intervals.integration.test.ts && rtk pnpm lint:migrations`

Expected: schema generation, source precedence, executable DB constraints, and migration policy pass.

```bash
rtk git add src/db/schema/activity.ts drizzle/0119_provider_neutral_activity_intervals.sql drizzle/meta/_journal.json docs/schema.dbml docs/schema.puml packages/server/src/repositories/intervals-repository.ts packages/server/src/repositories/cycling-training-metrics-repository.ts packages/server/src/mcp/cycling-training-metrics-output.ts src/db/activity-intervals.integration.test.ts packages/server/src/repositories/interval-source.test.ts
rtk git commit -m "feat: preserve provider-neutral activity intervals"
rtk git push
```

### Task 6: Share the complete server-side cycling effort metric bundle

**Files:**
- Create: `packages/server/src/repositories/cycling-effort-metrics.ts`
- Create: `packages/server/src/repositories/cycling-effort-metrics.test.ts`
- Modify: `packages/server/src/repositories/cycling-training-metrics-repository.ts`
- Modify: `packages/server/src/repositories/performance-comparison-context.ts`
- Modify: `packages/server/src/repositories/performance-comparison-repository.ts`
- Modify: `packages/server/src/repositories/performance-comparison-repository.test.ts`
- Modify: `packages/server/src/mcp/performance-comparison-output.ts`

**Interfaces:**
- Produces `CyclingEffortMetrics` for a bounded set of canonical activity IDs, calculated from deduplicated sensor samples and effective-dated settings.
- Includes elapsed/moving duration, distance/speed, elevation, average/normalized power, work, variability index, HR/cadence, power/HR and speed/HR, climb vertical speed, drift, power/HR zones, descriptive best powers, body-weight evidence/W/kg, interval metrics, environmental evidence, and per-stream quality.
- FTP-dependent values resolve settings independently per activity date; missing historical FTP stays null with a reason.

- [ ] **Step 1: Write failing metric bundle tests.**

```ts
it("calculates comparable cycling metrics from deduplicated samples", async () => {
  const result = await calculateCyclingEffortMetrics(fixtureSamples, fixtureContext);
  expect(result).toMatchObject({
    averagePowerWatts: 210,
    normalizedPowerWatts: 220,
    workKilojoules: 378,
    variabilityIndex: expect.any(Number),
    quality: { status: "high" },
  });
});

it("does not apply a current FTP to a historical activity", async () => {
  const result = await calculateCyclingEffortMetrics(fixtureSamples, { ftp: null });
  expect(result.thresholds.ftp).toBeNull();
  expect(result.unavailableReasons).toContainEqual({
    metric: "intensity_factor",
    reason: "no contemporaneous FTP",
  });
});
```

- [ ] **Step 2: Run the focused metric tests and verify the missing calculator failure.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts --project unit`

Expected: FAIL because the shared metric calculator does not yet exist.

- [ ] **Step 3: Extract the existing calculation paths into the shared metric module.**

Move only shared calculation/query types and helpers from `cycling-training-metrics-repository.ts`; keep its public range response backward compatible. Use the existing `analytics.activity_sensor_sample FINAL`/summary model boundary, `BodyRepository` weight selection policy, effective-dated threshold lookup, and recorded/inferred interval implementation.

- [ ] **Step 4: Add the missing cycling comparison fields and provenance.**

Calculate moving speed only from provider-reported moving duration or covered speed samples, speed/HR only when both streams have valid comparable coverage, vertical speed only for valid climb/elevation windows, and expose suspicious/conflicting samples and missing reasons. Label `best_powers` as descriptive observed maxima within the effort, never maximal tests.

- [ ] **Step 5: Run focused and existing cycling tests.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/cycling-effort-metrics.test.ts packages/server/src/repositories/cycling-training-metrics-repository.test.ts packages/server/src/mcp/cycling-training-metrics-tool.test.ts packages/server/src/mcp/performance-comparison-tool.test.ts --project unit`

Expected: new metric tests pass and existing cycling/comparison contracts remain valid until the deliberate output-schema changes in Task 8.

- [ ] **Step 6: Commit the shared metric bundle.**

```bash
rtk git add packages/server/src/repositories/cycling-effort-metrics.ts packages/server/src/repositories/cycling-effort-metrics.test.ts packages/server/src/repositories/cycling-training-metrics-repository.ts packages/server/src/repositories/performance-comparison-context.ts packages/server/src/repositories/performance-comparison-repository.ts packages/server/src/repositories/performance-comparison-repository.test.ts packages/server/src/mcp/performance-comparison-output.ts
rtk git commit -m "feat: share cycling effort metrics"
rtk git push
```

### Task 7: Add repeated-effort discovery repository and MCP tool

**Files:**
- Create: `packages/server/src/repositories/repeated-efforts-repository.ts`
- Create: `packages/server/src/repositories/repeated-efforts-repository.test.ts`
- Create: `packages/server/src/mcp/repeated-efforts-output.ts`
- Create: `packages/server/src/mcp/repeated-efforts-tool.ts`
- Create: `packages/server/src/mcp/repeated-efforts-tool.test.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`

**Interfaces:**
- `RepeatedEffortsRepository.find(input: FindRepeatedEffortsInput): Promise<FindRepeatedEffortsOutput>` queries canonical activities, identity evidence, route identity, and user benchmark memberships.
- Default `equivalence_strength: "strong"` includes exact and strongly inferred groups only; `weak` includes separately labeled name/duration candidates.
- Output contains effort/equivalence ID, kind, display/provider/modality, expected duration, repetitions, first/last occurrence, canonical IDs, source evidence, strength, assumptions, and quality flags.

- [ ] **Step 1: Write failing repository tests for exact, weak, and merged-source behavior.**

```ts
it("groups identical provider workout identities across canonical activities", async () => {
  const result = await repository.find({
    startDate: "2020-01-01", endDate: "2026-12-31", minimumRepetitions: 2,
    equivalenceStrength: "strong", effortKind: "provider_workout",
  });
  expect(result.groups).toEqual([
    expect.objectContaining({ kind: "provider_workout", strength: "exact", repetitionCount: 3 }),
  ]);
});

it("does not group same-name activities as exact", async () => {
  const result = await repository.find({
    startDate: "2020-01-01", endDate: "2026-12-31", minimumRepetitions: 2,
    equivalenceStrength: "strong", effortKind: "activity_name",
  });
  expect(result.groups).toEqual([]);
});

it("preserves both providers when one canonical activity has merged members", async () => {
  const result = await repository.find({ startDate: "2020-01-01", endDate: "2026-12-31", minimumRepetitions: 2 });
  expect(result.groups[0]?.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: "apple_health" }),
    expect.objectContaining({ provider: "strava" }),
  ]));
});
```

- [ ] **Step 2: Run the repository test and verify it fails because the repository/tool does not exist.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/mcp/repeated-efforts-tool.test.ts --project unit`

Expected: FAIL with missing module or missing method errors.

- [ ] **Step 3: Implement the bounded repository query and cursor.**

Use `executeWithSchema` for Postgres benchmark groups and the typed ClickHouse store for identity/route projections. Group by namespaced identity key, exclude canonical activities with invalid timestamps or no usable identity, aggregate all member/source evidence, and apply repetition/date/provider/modality/type filters before pagination. Return distinct exact/strong/weak groups rather than collapsing strengths.

- [ ] **Step 4: Register `find_repeated_efforts` and its strict output schema.**

Require `activity:read`, validate date ranges and maximums, default minimum repetitions to 2 and limit to 25, and describe Level A/B/C/D evidence plus the non-maximal caveat in the tool description. Add the tool to the registry and route listing/sentinel tests.

- [ ] **Step 5: Run focused MCP tests and commit.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/mcp/repeated-efforts-tool.test.ts packages/server/src/mcp/route.test.ts --project unit`

Expected: repository grouping, strict schema validation, scope enforcement, and tool advertisement pass.

```bash
rtk git add packages/server/src/repositories/repeated-efforts-repository.ts packages/server/src/repositories/repeated-efforts-repository.test.ts packages/server/src/mcp/repeated-efforts-output.ts packages/server/src/mcp/repeated-efforts-tool.ts packages/server/src/mcp/repeated-efforts-tool.test.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts
rtk git commit -m "feat: discover repeated efforts"
rtk git push
```

### Task 8: Generalize `compare_performances` around identity evidence

**Files:**
- Modify: `packages/server/src/repositories/performance-comparison-types.ts`
- Modify: `packages/server/src/repositories/performance-comparison-repository.ts`
- Modify: `packages/server/src/repositories/performance-comparison-context.ts`
- Modify: `packages/server/src/mcp/performance-comparison-tool.ts`
- Modify: `packages/server/src/mcp/performance-comparison-output.ts`
- Modify: `packages/server/src/mcp/performance-comparison-tool.test.ts`
- Modify: `packages/server/src/mcp/route.test.ts`

**Interfaces:**
- Replaces the Peloton literal provider with provider-agnostic `provider_workout`, `provider_route`, `canonical_route`, `segment`, `climb`, `standardized_test`, `activity_name`, and `user_defined_benchmark` specifications.
- `reference_activity_id` resolves the strongest available exact/strong evidence; explicit activity-name equivalence is caller-asserted and weak unless explicitly asserted.
- Each result returns identity kind/value/namespace, strength, basis, method, assumptions, route geometry evidence, source/member evidence, metric evidence, and quality.

- [ ] **Step 1: Add failing tests for every requested equivalence distinction.**

```ts
it("accepts the same provider workout identity for any provider", async () => {
  await callTool("compare_performances", { equivalence: {
    kind: "provider_workout", provider: "zwift", value: "workout-17",
  }});
  expect(mockCompare).toHaveBeenCalledWith(expect.objectContaining({ equivalence: {
    kind: "provider_workout", provider: "zwift", value: "workout-17",
  }}));
});

it("labels caller-asserted equivalence separately from exact identity", async () => {
  const result = await callTool("compare_performances", { equivalence: {
    kind: "activity_name", canonical_type: "cycling", value: "FTP Test",
  }});
  expect(result.result.equivalence).toMatchObject({ basis: "caller_asserted", strength: "caller_asserted" });
});

it("returns inferred route evidence instead of silently claiming exact identity", async () => {
  const result = await repository.compare({ equivalence: { kind: "canonical_route", value: "route-fingerprint" } });
  expect(result.result.equivalence).toMatchObject({ strength: "strong_inferred" });
  expect(result.result.performances[0]?.route.geometry).toHaveProperty("overlap_percentage");
});
```

- [ ] **Step 2: Run the comparison tests and verify the old Peloton-only schema rejects the new provider-neutral input.**

Run: `rtk pnpm exec vitest run packages/server/src/mcp/performance-comparison-tool.test.ts packages/server/src/repositories/performance-comparison-repository.test.ts --project unit`

Expected: FAIL on new provider-neutral inputs and missing route/metric output fields.

- [ ] **Step 3: Replace raw Peloton lookup predicates with identity-model predicates.**

Resolve identities through `activity_effort_identity` and `activity_route_identity`, retain the current canonical `fitness.v_activity` activity selection, and reject ambiguous/conflicting exact identities unless the caller selects a specific namespaced value. Keep legacy input aliases only where their semantics remain identical; do not leave a Peloton-only branch.

- [ ] **Step 4: Wire the shared cycling metrics and full evidence bundle.**

Replace the comparison repository’s narrow sensor summary calculation with Task 6 output. Keep non-cycling climbing/strength behavior intact, preserve source links/member IDs, and add exact/strong/caller/weak flags plus route geometry evidence to every performance.

- [ ] **Step 5: Update tool descriptions and strict schemas.**

Document Level A exact identity, Level B strong inference, Level C caller assertion, Level D weak similarity, and the lower-bound/maximal-effort caveat. Ensure nullable metrics have explicit unavailable reasons and stale FTP never supplies historical thresholds.

- [ ] **Step 6: Run comparison, route, metrics, and MCP registry tests.**

Run: `rtk pnpm exec vitest run packages/server/src/mcp/performance-comparison-tool.test.ts packages/server/src/repositories/performance-comparison-repository.test.ts packages/server/src/mcp/route.test.ts packages/server/src/repositories/cycling-effort-metrics.test.ts --project unit`

Expected: all provider-neutral identity distinctions, schema snapshots, evidence output, and compatibility tests pass.

```bash
rtk git add packages/server/src/repositories/performance-comparison-types.ts packages/server/src/repositories/performance-comparison-repository.ts packages/server/src/repositories/performance-comparison-context.ts packages/server/src/mcp/performance-comparison-tool.ts packages/server/src/mcp/performance-comparison-output.ts packages/server/src/mcp/performance-comparison-tool.test.ts packages/server/src/mcp/route.test.ts
rtk git commit -m "feat: generalize performance comparisons"
rtk git push
```

### Task 9: Add `get_effort_trend` as a comparison-service projection

**Files:**
- Create: `packages/server/src/repositories/effort-trend-repository.ts`
- Create: `packages/server/src/repositories/effort-trend-repository.test.ts`
- Create: `packages/server/src/mcp/effort-trend-output.ts`
- Create: `packages/server/src/mcp/effort-trend-tool.ts`
- Create: `packages/server/src/mcp/effort-trend-tool.test.ts`
- Modify: `packages/server/src/mcp/tools.ts`
- Modify: `packages/server/src/mcp/route.test.ts`

**Interfaces:**
- `EffortTrendRepository.get(input): Promise<EffortTrendOutput>` resolves a discovery effort ID or explicit equivalence and delegates candidate selection/metrics to `PerformanceComparisonRepository`.
- Output rows contain chronological repetition, comparable metrics, delta to first/previous/best, rolling descriptive trend, quality, evidence, assumptions, and caveats.

- [ ] **Step 1: Write the failing trend tests.**

```ts
it("calculates deltas to first, previous, and best without changing equivalence", async () => {
  const result = await repository.get({ effortId: "provider_workout:zwift:17", startDate: "2020-01-01", endDate: "2026-12-31" });
  expect(result.repetitions.map((row) => row.delta_to_first.average_power_watts)).toEqual([0, 12, 8]);
  expect(result.repetitions[2]).toMatchObject({ delta_to_previous: { average_power_watts: -4 } });
  expect(compareMock).toHaveBeenCalledTimes(1);
});

it("keeps trend caveats when repetitions have incomplete samples", async () => {
  const result = await repository.get({ equivalence: { kind: "canonical_route", value: "r1" }, startDate: "2020-01-01", endDate: "2026-12-31" });
  expect(result.caveats).toContain("Some repetitions have limited sample coverage");
});
```

- [ ] **Step 2: Run the trend tests and verify the missing implementation failure.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/effort-trend-repository.test.ts packages/server/src/mcp/effort-trend-tool.test.ts --project unit`

Expected: FAIL because the trend repository and tool are absent.

- [ ] **Step 3: Implement the repository projection and strict output schema.**

Use the comparison result’s ordered performances; calculate deltas only when both values are present, choose best by the metric’s documented direction, and make rolling trends descriptive with a minimum-observation reason. Do not calculate a physiological decline claim.

- [ ] **Step 4: Register the tool and verify MCP advertisement/scope.**

Require `activity:read`, validate inclusive date ranges and exactly one effort ID/equivalence specification, and include the same evidence-level and non-maximal caveats in the description.

- [ ] **Step 5: Run focused tests and commit.**

Run: `rtk pnpm exec vitest run packages/server/src/repositories/effort-trend-repository.test.ts packages/server/src/mcp/effort-trend-tool.test.ts packages/server/src/mcp/route.test.ts --project unit`

Expected: trend deltas, caveats, schema validation, and tool listing pass.

```bash
rtk git add packages/server/src/repositories/effort-trend-repository.ts packages/server/src/repositories/effort-trend-repository.test.ts packages/server/src/mcp/effort-trend-output.ts packages/server/src/mcp/effort-trend-tool.ts packages/server/src/mcp/effort-trend-tool.test.ts packages/server/src/mcp/tools.ts packages/server/src/mcp/route.test.ts
rtk git commit -m "feat: add repeated effort trends"
rtk git push
```

### Task 10: Add idempotent historical backfill and operational documentation

**Files:**
- Create: `src/db/activity-effort-identity-backfill.ts`
- Create: `scripts/backfill-activity-effort-identities.ts`
- Create: `scripts/backfill-activity-effort-identities.test.ts`
- Modify: `package.json` with `backfill:activity-effort-identities`
- Modify: `scripts/README.md`
- Create: `docs/activity-effort-identity-runbook.md`
- Modify: `docs/README.md`
- Modify: `docs/mcp.md`

**Interfaces:**
- `backfillActivityEffortIdentities(db, options): Promise<{ scanned, inserted, updated, skipped, conflicts }>` accepts explicit user/date bounds and a dry-run/execute flag.
- The script reads stored raw payloads only, upserts by `(user, source activity, kind, namespace, value, source field)`, reports unsupported/conflicting fields, and is safe to rerun.

- [ ] **Step 1: Write failing parser/idempotency tests.**

```ts
it("extracts stable IDs but not provider activity instance IDs", () => {
  expect(extractActivityEffortIdentities({
    providerId: "peloton",
    externalId: "instance-1",
    raw: { pelotonClassId: "class-1", id: "instance-1" },
  })).toEqual([expect.objectContaining({ kind: "provider_workout", value: "class-1" })]);
});

it("does not insert a duplicate when the backfill is rerun", async () => {
  await backfillActivityEffortIdentities(db, options);
  await backfillActivityEffortIdentities(db, options);
  expect(await countIdentityRows(db, userId)).toBe(1);
});
```

- [ ] **Step 2: Run the script tests and verify the missing implementation failure.**

Run: `rtk pnpm exec vitest run scripts/backfill-activity-effort-identities.test.ts --project unit`

Expected: FAIL because the extractor/backfill module is absent.

- [ ] **Step 3: Implement bounded extraction and idempotent persistence.**

Use the same versioned provider-field mapping as the dbt identity model. Fail fast when required bounds are absent or invalid, cap the date window per existing backfill conventions, preserve unknown raw data, and call `captureException` for unexpected script failures.

- [ ] **Step 4: Add the script wrapper and runbook.**

Document dry-run and execute commands through `pnpm tsx scripts/with-env.ts --`, required CDC/dbt refresh ordering, provider fields recovered from raw payloads, provider network fetches intentionally excluded, conflict reporting, rollback by deleting only rows created by the backfill key, and route model refresh requirements. Add links to the authoritative MCP/database/analytics docs.

- [ ] **Step 5: Run script tests and policy checks, then commit.**

Run: `rtk pnpm exec vitest run scripts/backfill-activity-effort-identities.test.ts --project unit && rtk pnpm lint:suppressions && rtk pnpm lint:analytics-policy`

Expected: parser/idempotency tests and policy checks pass.

```bash
rtk git add src/db/activity-effort-identity-backfill.ts scripts/backfill-activity-effort-identities.ts scripts/backfill-activity-effort-identities.test.ts package.json scripts/README.md docs/activity-effort-identity-runbook.md docs/README.md docs/mcp.md
rtk git commit -m "feat: backfill repeated effort identities"
rtk git push
```

### Task 11: Verify the full feature against historical cycling data

**Files:**
- Create: `scripts/report-repeated-cycling-efforts.ts`
- Create: `scripts/report-repeated-cycling-efforts.test.ts`
- Modify: `scripts/README.md` with the report command and output definitions
- Modify: `docs/mcp.md` with the analysis-agent workflow and false-fitness-conclusion warning

**Interfaces:**
- The report runs `find_repeated_efforts`/repository queries for a bounded authenticated user and date range, then runs selected comparisons/trends through the same repositories.
- It prints counts by effort kind and strength, exact provider-defined repeats, repeated routes, most frequent efforts, multi-year repetitions, provider identity coverage, historical limitations, and several longitudinal comparisons.

- [ ] **Step 1: Write report formatting tests using an explicit fixture result.**

```ts
it("reports exact provider repeats before weak descriptive candidates", () => {
  const text = formatRepeatedCyclingReport({
    groups: [
      { kind: "activity_name", strength: "weak_similarity", repetitionCount: 4, firstOccurrence: "2021-01-01", lastOccurrence: "2026-01-01" },
      { kind: "provider_workout", strength: "exact", repetitionCount: 3, firstOccurrence: "2021-02-01", lastOccurrence: "2026-02-01" },
    ],
  });
  expect(text.indexOf("provider_workout")).toBeLessThan(text.indexOf("activity_name"));
});
```

- [ ] **Step 2: Run the report test and verify it fails before the formatter exists.**

Run: `rtk pnpm exec vitest run scripts/report-repeated-cycling-efforts.test.ts --project unit`

Expected: FAIL because the report formatter is absent.

- [ ] **Step 3: Implement the report with explicit incomplete-data handling.**

Use the authenticated production/local environment configured by `with-env.ts`, do not print secrets, and state when ClickHouse/dbt or historical provider coverage is incomplete. Select examples in this order: exact workouts/tests, exact/high-confidence routes/climbs, strongly comparable structured efforts, same-name/same-duration candidates, then generic observed power only as descriptive evidence.

- [ ] **Step 4: Run the report against the available historical cycling range.**

Run: `rtk pnpm tsx scripts/with-env.ts -- pnpm tsx scripts/report-repeated-cycling-efforts.ts --start=2000-01-01 --end=2099-12-31`

Expected: a bounded report containing repetition counts, provider identity coverage, route quality, comparisons, and explicit limitations. If the environment cannot access the historical dataset or analytics models, the command must fail loudly with the prerequisite and the final report must state that verification is blocked.

- [ ] **Step 5: Run final validation before claiming completion.**

Run: `rtk pnpm lint && rtk pnpm typecheck && rtk pnpm test:all`

Expected: all lint, typecheck, unit/mobile, and integration tests pass with zero failures. If Docker or a prerequisite fails, record the exact command, first fatal line, and root cause before changing anything.

- [ ] **Step 6: Inspect the final diff, commit, and push.**

```bash
rtk git diff --check
rtk git status --short
rtk git add scripts/report-repeated-cycling-efforts.ts scripts/report-repeated-cycling-efforts.test.ts scripts/README.md docs/mcp.md
rtk git commit -m "test: verify repeated cycling analysis"
rtk git push
```

Expected: the worktree is clean and the branch tracks the pushed remote commit.

## Plan self-review

Final review scope correction: recorded cycling sequence discovery is deferred
until a cycling provider supplies defensible recorded interval provenance and
targets. Task 5 delivers normalization/provenance, not a sequence identity.
The [design's structured-workout section](../specs/2026-09-10-repeated-effort-identity-design.md#structured-workout-and-interval-identity)
records the source audit and the prerequisites; no tool may promote legacy or
inferred intervals to strong recorded-protocol equivalence.

- Identity kinds and instance/template distinction: Tasks 1, 3, 7, and 8.
- Multi-provider dedup preservation: Tasks 3 and 7.
- Explicit and inferred route identity/evidence: Tasks 1 and 4.
- Provider-neutral intervals and interval provenance: Task 5.
- Cycling metric coverage, stale FTP, quality, and context: Task 6 and Task 8.
- Discovery, comparison, trend tools: Tasks 7–9.
- Historical backfill and provider-network limitation: Task 10.
- Real-data verification and false fitness conclusion guard: Task 11.
- Tests are written before implementation in every task and database semantics use executable integration tests.
- No task uses placeholder instructions, an unbounded migration backfill, raw metric-stream reads, or a development HTTP server.
