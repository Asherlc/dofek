# Clinical Record Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Clinical Health Records a real, read-only HealthKit feature with canonical FHIR storage, web/mobile presentation, a seeded App Review account, and current native screenshots.

**Architecture:** A single `fitness.clinical_record` table stores the original FHIR payload for every supported `HKClinicalType`. The iOS bridge queries `HKClinicalRecord`, the HealthKit sync sends typed records to a server mutation, and server-owned display summaries power equivalent web and mobile list/detail views. A migration moves existing legacy clinical rows into this table before deleting their duplicate sources of truth.

**Tech Stack:** Swift/HealthKit, Expo Modules, TypeScript, Zod, tRPC, Drizzle/PostgreSQL, React Native/Expo Router, React/TanStack Router, Vitest, XCTest, App Store Connect CLI.

**Spec:** `docs/superpowers/specs/2026-08-28-clinical-record-vault-design.md`

## Global Constraints

- Clinical access is read-only, opt-in, and never background-delivered.
- Store one raw FHIR source of truth in `fitness.clinical_record`; do not retain parallel typed clinical tables.
- Compute record summaries on the server; web and iOS render only server-authored values.
- Preserve per-user and per-provider attribution and include clinical records in provider/account deletion.
- Use TDD: every production change starts from a focused failing test.
- Capture release-candidate native screens on 6.5-inch iPhone and 13-inch iPad after successful sign-in to the synthetic review account.

---

### Task 1: Define canonical storage and migrate legacy clinical data

**Files:**

- Modify: `src/db/schema/clinical.ts`
- Create: `drizzle/0099_canonical_clinical_records.sql`
- Modify: `drizzle/_views/07_provider_stats.sql`
- Test: `src/db/schema/clinical.test.ts`
- Test: `src/db/clinical-record-migration.integration.test.ts`

**Interfaces:**

- Produces `clinicalRecord` with `userId`, `providerId`, `externalId`, `clinicalType`, `displayName`, `sourceName`, `fhirVersion`, `fhir`, `downloadedAt`, `recordedAt`, and `issuedAt`.
- Consumes legacy clinical tables only inside the forward migration.

- [ ] **Step 1: Write failing schema and migration integration tests**

```ts
it("stores one FHIR record per user, provider, and HealthKit UUID", async () => {
  await db.insert(clinicalRecord).values(record("user-a", "uuid-1"));
  await expect(db.insert(clinicalRecord).values(record("user-a", "uuid-1"))).rejects.toThrow();
});

it("backfills legacy records then drops legacy relations", async () => {
  await seedLegacyLabResult(db);
  await applyMigration("0099_canonical_clinical_records");
  expect(await readClinicalRecords("review-user")).toContainEqual(
    expect.objectContaining({ clinicalType: "labResult" }),
  );
  await expectRelationAbsent("fitness.lab_result");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm test:integration -- src/db/clinical-record-migration.integration.test.ts`

Expected: FAIL because `clinicalRecord` and migration `0099` do not exist.

- [ ] **Step 3: Implement the schema and migration**

```ts
export const clinicalRecord = fitness.table("clinical_record", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => userProfile.id),
  providerId: text("provider_id").notNull().references(() => provider.id),
  externalId: text("external_id").notNull(),
  clinicalType: text("clinical_type").notNull(),
  displayName: text("display_name").notNull(),
  sourceName: text("source_name"),
  fhirVersion: text("fhir_version").notNull(),
  fhir: jsonb("fhir").notNull(),
  downloadedAt: timestamp("downloaded_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
}, (table) => [uniqueIndex("clinical_record_user_provider_external_idx").on(table.userId, table.providerId, table.externalId)]);
```

Backfill raw FHIR-shaped JSON, redirect provider stats/deletion catalogs, then remove legacy tables and exports.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test:integration -- src/db/clinical-record-migration.integration.test.ts && pnpm typecheck`

Expected: PASS; legacy rows appear exactly once in the canonical table and legacy relations no longer exist.

- [ ] **Step 5: Commit and push**

```bash
git add src/db/schema/clinical.ts src/db/schema/clinical.test.ts drizzle/0099_canonical_clinical_records.sql drizzle/_views/07_provider_stats.sql src/db/clinical-record-migration.integration.test.ts
git commit -m "feat: canonicalize clinical FHIR records"
git push
```

### Task 2: Add server FHIR validation, summaries, and tRPC API

**Files:**

- Create: `packages/server/src/clinical-records/fhir.ts`
- Create: `packages/server/src/clinical-records/repository.ts`
- Create: `packages/server/src/routers/clinical-records.ts`
- Modify: `packages/server/src/router.ts`
- Test: `packages/server/src/clinical-records/fhir.test.ts`
- Test: `packages/server/src/clinical-records/repository.integration.test.ts`
- Test: `packages/server/src/routers/clinical-records.test.ts`

**Interfaces:**

- Produces `clinicalRecords.push`, `clinicalRecords.list`, and `clinicalRecords.detail`.
- `push` accepts `records: ClinicalRecordInput[]`; `list` returns server-authored `ClinicalRecordSummary[]`.

- [ ] **Step 1: Write failing API tests**

```ts
it("rejects FHIR whose resource type conflicts with its HealthKit type", async () => {
  await expect(caller.clinicalRecords.push({ records: [conditionWithObservationFhir] }))
    .rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("does not return another user's record", async () => {
  await insertClinicalRecordFor("user-b");
  expect(await callerFor("user-a").clinicalRecords.list({ limit: 20, offset: 0 }))
    .toEqual({ records: [], nextOffset: null });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- packages/server/src/routers/clinical-records.test.ts`

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement validation, repository, and procedures**

```ts
export const clinicalRecordInputSchema = z.object({
  externalId: z.string().uuid(), clinicalType: z.enum(CLINICAL_TYPE_IDS),
  displayName: z.string().min(1), sourceName: z.string().nullable(),
  fhirVersion: z.string().min(1), fhir: z.record(z.string(), z.unknown()),
  downloadedAt: z.string().datetime(),
});

export const clinicalRecordsRouter = router({
  push: protectedProcedure.input(z.object({ records: z.array(clinicalRecordInputSchema).max(100) })).mutation(pushClinicalRecords),
  list: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).input(pageSchema).query(listClinicalRecords),
  detail: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).input(z.object({ id: z.uuid() })).query(readClinicalRecord),
});
```

Validate resource type before upsert, derive labels/dates on the server, and return `NOT_FOUND` for cross-user detail requests.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- packages/server/src/clinical-records/fhir.test.ts packages/server/src/routers/clinical-records.test.ts && pnpm test:integration -- packages/server/src/clinical-records/repository.integration.test.ts`

Expected: PASS with executable Postgres isolation and upsert coverage.

- [ ] **Step 5: Commit and push**

```bash
git add packages/server/src/clinical-records packages/server/src/routers/clinical-records.ts packages/server/src/router.ts
git commit -m "feat: serve canonical clinical records"
git push
```

### Task 3: Query every supported clinical type through the native bridge

**Files:**

- Modify: `packages/mobile/modules/health-kit/ios/HealthKitModule.swift`
- Modify: `packages/mobile/modules/health-kit/index.ts`
- Modify: `packages/mobile/modules/health-kit/ios/HealthKitTypes.swift`
- Test: `packages/mobile/modules/health-kit/Tests/HealthKitQueriesTests.swift`
- Test: `packages/mobile/modules/health-kit/Tests/HealthKitTypesTests.swift`

**Interfaces:**

- Produces `queryClinicalRecords(typeIdentifier, startDate, endDate): Promise<ClinicalRecordSample[]>`.
- `ClinicalRecordSample` includes UUID, clinical type, display/source/FHIR metadata, FHIR JSON, and HealthKit download time.

- [ ] **Step 1: Write failing XCTest coverage**

```swift
func testClinicalRecordMapsFHIRPayloadAndDownloadDate() throws {
    let result = try HealthKitQueries.mapClinicalRecord(sample)
    XCTAssertEqual(result["uuid"] as? String, "clinical-uuid")
    XCTAssertEqual(result["fhirVersion"] as? String, "4.0.1")
}
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir packages/mobile test:native -- HealthKitQueriesTests`

Expected: FAIL because clinical mapping/query support does not exist.

- [ ] **Step 3: Implement `HKSampleQuery` bridge**

```swift
let query = HKSampleQuery(sampleType: clinicalType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: descriptors) { _, samples, error in
  promise.resolve(try (samples ?? []).map(HealthKitQueries.mapClinicalRecord))
}
healthStore.execute(query)
```

Expose the method in TypeScript, gate clinical note by OS availability, and do not add clinical types to `backgroundDeliveryTypes`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --dir packages/mobile test:native -- HealthKitQueriesTests HealthKitTypesTests`

Expected: PASS; supported types map correctly and no clinical type is background-observed.

- [ ] **Step 5: Commit and push**

```bash
git add packages/mobile/modules/health-kit
git commit -m "feat: query HealthKit clinical records"
git push
```

### Task 4: Send clinical records only during explicit sync

**Files:**

- Modify: `packages/mobile/lib/health-kit-sync.ts`
- Modify: `packages/mobile/lib/apple-health-provider.ts`
- Test: `packages/mobile/lib/health-kit-sync.test.ts`
- Test: `packages/mobile/lib/apple-health-provider.test.ts`

**Interfaces:**

- Extends `HealthKitAdapter` with `queryClinicalRecords` and `SyncTrpcClient` with `clinicalRecords.push`.
- Produces a clinical-record sync stage and includes its inserted count in the existing sync result.

- [ ] **Step 1: Write failing sync tests**

```ts
it("pushes clinical records only during an explicit sync", async () => {
  await syncHealthKitToServer({ healthKit: adapterWithClinicalRecord, trpcClient, syncRangeDays: 7 });
  expect(trpcClient.clinicalRecords.push.mutate).toHaveBeenCalledWith({ records: [clinicalRecord] });
});

it("does not add clinical records to observer sync", () => {
  expect(BACKGROUND_HEALTH_KIT_TYPES).not.toContain("HKClinicalTypeIdentifierLabResultRecord");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test:mobile -- packages/mobile/lib/health-kit-sync.test.ts`

Expected: FAIL because clinical query/push is absent.

- [ ] **Step 3: Implement bounded batches**

```ts
for (const typeIdentifier of CLINICAL_TYPE_IDENTIFIERS) {
  const records = await healthKit.queryClinicalRecords(typeIdentifier, startDate, endDate);
  if (records.length) totalInserted += (await trpcClient.clinicalRecords.push.mutate({ records })).inserted;
}
```

Keep progress text specific and surface server errors without fallback data.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test:mobile -- packages/mobile/lib/health-kit-sync.test.ts packages/mobile/lib/apple-health-provider.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add packages/mobile/lib/health-kit-sync.ts packages/mobile/lib/apple-health-provider.ts packages/mobile/lib/*.test.ts
git commit -m "feat: sync clinical records on demand"
git push
```

### Task 5: Build equivalent web/mobile record list and detail views

**Files:**

- Create: `packages/mobile/app/clinical-records.tsx`
- Create: `packages/mobile/app/clinical-record/[id].tsx`
- Create: `packages/mobile/app-tests/clinical-records.test.tsx`
- Create: `packages/web/src/routes/clinical-records.tsx`
- Create: `packages/web/src/routes/clinical-records.$id.tsx`
- Create: `packages/web/src/pages/clinical-records.tsx`
- Test: `packages/web/src/pages/clinical-records.test.tsx`
- Modify: `packages/mobile/app/providers/provider-detail-actions-card.tsx`
- Modify: `packages/web/src/pages/provider-detail-data.tsx`

**Interfaces:**

- Consumes `trpc.clinicalRecords.list` and `.detail` only.
- Produces mobile `/clinical-records`, `/clinical-record/:id` and web `/clinical-records`, `/clinical-records/$id`.

- [ ] **Step 1: Write failing UI tests**

```tsx
it("renders a server-authored record summary and opens its detail", async () => {
  render(<ClinicalRecordsScreen />, { trpc: seededClinicalRecords });
  await userEvent.click(await screen.findByRole("link", { name: /wellness panel/i }));
  expect(await screen.findByText("FHIR resource")).toBeVisible();
});

it("shows the specific server error", async () => {
  render(<ClinicalRecordsScreen />, { trpcError: new TRPCClientError("Clinical data is unavailable.") });
  expect(await screen.findByText("Clinical data is unavailable.")).toBeVisible();
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test:mobile -- packages/mobile/app-tests/clinical-records.test.tsx && pnpm test -- packages/web/src/pages/clinical-records.test.tsx`

Expected: FAIL because the views do not exist.

- [ ] **Step 3: Implement the UI**

Use `QueryStatePanel` for distinct loading/error/empty states, render server-provided labels only, show read-only FHIR JSON on detail, and add the Apple Health provider link. Label review data “Demo data — synthetic.”

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test:mobile -- packages/mobile/app-tests/clinical-records.test.tsx && pnpm test -- packages/web/src/pages/clinical-records.test.tsx && pnpm typecheck`

Expected: PASS on both platforms.

- [ ] **Step 5: Commit and push**

```bash
git add packages/mobile/app packages/mobile/app-tests packages/mobile/components packages/web/src/routes packages/web/src/pages
git commit -m "feat: display clinical records on web and mobile"
git push
```

### Task 6: Redirect import, deletion, analytics, and review seeding

**Files:**

- Modify: `src/providers/apple-health/import.ts`
- Modify: `src/providers/apple-health/fhir.ts`
- Modify: `packages/server/src/repositories/provider-detail-repository.ts`
- Modify: `packages/server/src/repositories/nutrition-analytics-repository.ts`
- Modify: `scripts/seed/core.ts`
- Modify: `scripts/seed/body-health.ts`
- Test: `src/providers/apple-health/import.integration.test.ts`
- Test: `src/jobs/process-provider-data-deletion-job.integration.test.ts`

**Interfaces:**

- ZIP imports and seed data write `fitness.clinical_record` only.
- Provider/account erasure includes `fitness.clinical_record`.

- [ ] **Step 1: Write failing executable integration tests**

```ts
it("imports FHIR records into the canonical table", async () => {
  await importAppleHealthFile(fixtureZip);
  expect(await recordsForUser(USER_ID)).toHaveLength(9);
});

it("deletes only the selected provider's clinical records", async () => {
  await deleteProviderData({ userId, providerId: "apple_health" });
  expect(await recordsForUser(userId, "apple_health")).toEqual([]);
  expect(await recordsForUser(userId, "other_provider")).toHaveLength(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test:integration -- src/providers/apple-health/import.integration.test.ts src/jobs/process-provider-data-deletion-job.integration.test.ts`

Expected: FAIL because legacy writers/deleters remain.

- [ ] **Step 3: Implement the canonical paths**

Replace every legacy clinical writer and reader; update the medication-presence query to inspect canonical FHIR resource types. Seed deterministic synthetic FHIR for every supported type and add review-data display metadata.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test:integration -- src/providers/apple-health/import.integration.test.ts src/jobs/process-provider-data-deletion-job.integration.test.ts && pnpm tsx scripts/with-env.ts -- pnpm seed`

Expected: PASS; seed has complete synthetic coverage and scoped deletion removes it.

- [ ] **Step 5: Commit and push**

```bash
git add src/providers/apple-health packages/server/src/repositories scripts/seed src/jobs
git commit -m "feat: seed and delete canonical clinical records"
git push
```

### Task 7: Document review flow and produce native evidence

**Files:**

- Modify: `packages/mobile/app-store/README.md`
- Modify: `packages/mobile/README.md`
- Create: `.asc/shots.settings.json`
- Create: `.asc/screenshots.json`
- Create: generated artifacts under `packages/mobile/app-store/screenshots/review/` if versioned
- Modify: App Store Connect review notes and media (external operation)

**Interfaces:**

- Capture plan signs into the permanent review account and takes Today, provider, clinical list, and detail screens for each required device.

- [ ] **Step 1: Add direct review acceptance criteria**

```text
iPhone 6.5 and iPad 13 each require native captures for Today, Apple Health provider controls, Clinical Records list, and Clinical Record detail.
Review notes require permanent credentials, synthetic-data disclosure, opt-in sync path, provider-data deletion path, and storage/access explanation.
```

- [ ] **Step 2: Verify capture prerequisites**

Run: `asc screenshots --help && asc screenshots sizes --output table && xcrun simctl list devices available`

Expected: exact current CLI flags plus suitable iPhone and iPad simulators.

- [ ] **Step 3: Build and capture final-candidate screens**

Create the settings and plan; build, sign in to the permanent review account, and use AXe or `asc screenshots run`. Separately run a physical iPhone authorization/query acceptance check; simulator output is UI evidence only.

- [ ] **Step 4: Validate media**

Run: `asc screenshots review-generate --framed-dir ./screenshots/framed --output-dir ./screenshots/review && asc screenshots review-approve --all-ready --output-dir ./screenshots/review`

Expected: correct dimensions, current UI, no login/splash content, and visible synthetic clinical records.

- [ ] **Step 5: Commit and push documentation; upload only with explicit confirmation**

```bash
git add packages/mobile/app-store/README.md packages/mobile/README.md .asc
git commit -m "docs: document clinical record review evidence"
git push
```

Use `asc screenshots plan` and `asc screenshots apply --confirm` only after the user confirms the final media set and exact App Store version localization.

## Plan Self-Review

- Spec coverage: Tasks 1 and 6 deliver canonical storage, migration, deletion, and review fixtures; Tasks 2–4 deliver native-to-server sync; Task 5 delivers parity UI; Task 7 delivers physical-device and screenshot evidence.
- Placeholder scan: no TBD/TODO, generic error-handling, or unspecified implementation instructions remain.
- Type consistency: mobile uses `ClinicalRecordSample`; server uses `ClinicalRecordInput` and `ClinicalRecordSummary`; canonical storage is consistently `clinicalRecord` / `fitness.clinical_record`.

