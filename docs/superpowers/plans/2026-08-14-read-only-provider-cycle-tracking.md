# Read-Only Provider Cycle Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan.

Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore cycle tracking on web and iOS as a provider-fed, read-only feature, beginning with Apple Health menstrual-flow records, while permanently removing every first-party period input and its corresponding API.

**Architecture:** Preserve raw provider records in the existing `fitness.health_event` table with source bundle and structured metadata. Extend HealthKit native/background sync and Apple Health XML import to retain the menstrual-cycle-start marker. Add a read-only server repository/router that derives exact-date cycle starts and conservative phase estimates at query time. Restore web and iOS cycle routes as render-only views with provider attribution, source-correction guidance, privacy links, and no mutations.

**Tech Stack:** TypeScript, Swift/HealthKit, Drizzle ORM, PostgreSQL, tRPC, React/TanStack Router, React Native/Expo Router, Vitest, XCTest.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-08-14-read-only-provider-cycle-tracking-design.md`.
- Start by merging `origin/main` into the current branch without switching branches. Preserve the already-pushed design/incident commit and the unrelated untracked `paseo.json` file.
- Do not recreate `fitness.menstrual_period`, restore its export path, or recover former manual rows. Production has already run the migration that dropped the table.
- Do not add `logPeriod`, `updatePeriod`, `deletePeriod`, aliases for those procedures, or any first-party date/notes/edit/delete UI.
- Keep `fitness.health_event` as the single canonical raw store. Store raw source identity and metadata; compute cycle starts, deduplication, cycle length, and phase on the server at read time.
- Only an explicit upstream menstrual-flow sample with `HKMetadataKeyMenstrualCycleStart=true` is cycle evidence. Never infer a start from temperature, HRV, recovery, sleep, fertility, or wearable scores.
- Treat exact-date duplicates as the same observed start while retaining every source. Treat two distinct starts fewer than 21 days apart as conflicting source history and suppress the phase estimate.
- Keep HealthKit read-only: add `.menstrualFlow` to read/background types, never to `writeTypes`.
- A denied HealthKit read permission is intentionally indistinguishable from no readable records. Render neutral provider-data guidance rather than claiming the user has no cycles.
- All metric values and explanatory labels are server-authored. Web and mobile only format dates, colors, and layout.
- Follow TDD. Do not add tests whose sole purpose is proving removed procedures or controls are absent; delete obsolete mutation tests and verify API shape through normal typechecking.
- Use real PostgreSQL integration tests for date grouping and conflict behavior. Keep unit tests Docker-free and integration tests free of module-level mocks.
- Use `pnpm compose -- ...` for Compose-backed validation. Report unexpected caught errors to Sentry and surface server `error.message` to clients.
- Cite Apple, Garmin, and Android primary documentation in human-facing docs. Do not implement Garmin until official program access and its exact payload contract are available.

---

## Task 1: Reconcile the branch with the production code line

**Files:**

- Merge commit only; resolve `docs/production-incident-baseline.md` and `docs/superpowers/**` if necessary.
- Preserve untracked `paseo.json` unchanged and uncommitted.

- [ ] **Step 1 — Fetch and verify the merge target.**

Run:

```sh
git fetch origin
git rev-parse HEAD origin/main
git status --short --branch
```

Confirm `origin/main` contains `0089_remove_cycle_tracking_and_breathwork.sql` and `0090_remove_remaining_manual_health_inputs.sql`. Do not switch branches.

- [ ] **Step 2 — Merge `origin/main` into the current branch.**

Run:

```sh
git merge --no-edit origin/main
```

Resolve conflicts by retaining upstream production code plus the new design and incident entry. Never resolve by restoring the deleted manual schema or breathwork feature.

- [ ] **Step 3 — Verify and push the merge.**

Run:

```sh
git status --short
git diff --check
git push
```

Expected working-tree output after the merge is only `?? paseo.json`.

## Task 2: Preserve generic source identity and HealthKit metadata in raw events

**Files:**

- Modify `src/db/schema/clinical.ts`.
- Add `drizzle/0091_health_event_source_metadata.sql`.
- Modify `drizzle/meta/_journal.json`.
- Modify `docs/schema.dbml` and `docs/schema.puml` using the repository schema-generation command.
- Modify `packages/server/src/routers/health-kit-sync-schemas.ts`.
- Modify `packages/server/src/repositories/health-kit-sync-repository.ts`.
- Modify `packages/server/src/repositories/health-kit-sync-repository.test.ts`.

- [ ] **Step 1 — Write failing HealthKit ingestion tests.**

Extend the existing repository tests through `HealthKitSyncRepository.processHealthEvents()` with a category sample shaped as:

```ts
const menstrualStartSample = {
  type: "HKCategoryTypeIdentifierMenstrualFlow",
  value: 2,
  unit: "category",
  startDate: "2026-08-01T08:00:00-07:00",
  endDate: "2026-08-01T08:05:00-07:00",
  sourceName: "Cycle Source",
  sourceBundle: "com.example.cycle-source",
  uuid: "91C7A825-3DA3-4F24-9085-15A9E2D1D2A1",
  metadata: { HKMetadataKeyMenstrualCycleStart: true },
};
```

Assert that the executed insert carries `source_bundle` and JSON metadata as bind values and continues to use `hk:<uuid>` for idempotency. Add schema tests that accept boolean/string/number metadata and reject nested arrays/objects:

```ts
metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
```

- [ ] **Step 2 — Run focused tests and confirm failure.**

```sh
pnpm vitest run packages/server/src/repositories/health-kit-sync-repository.test.ts packages/server/src/routers/health-kit-sync-schemas.test.ts
```

If the schema assertions are colocated in another existing health-kit-sync test, use that file rather than creating a test file that does not map to a production source.

- [ ] **Step 3 — Add the forward-only raw-event columns.**

Add these generic fields to `healthEvent`:

```ts
sourceBundle: text("source_bundle"),
metadata: jsonb("metadata").$type<Record<string, string | number | boolean>>(),
```

Create migration `0091` with only:

```sql
ALTER TABLE "fitness"."health_event"
  ADD COLUMN "source_bundle" text,
  ADD COLUMN "metadata" jsonb;
```

Register it after `0090`. Do not backfill or rewrite historical rows in the deploy migration.

- [ ] **Step 4 — Carry metadata through the server sync contract.**

Update both HealthKit sample interfaces and the Zod schema to use:

```ts
metadata?: Record<string, string | number | boolean>;
```

Change `processHealthEvents()` to insert `source_bundle` and `metadata`, using `JSON.stringify(sample.metadata ?? {})` as a JSONB bind. Keep the existing provider ID, UUID external ID, value, unit, source name, and timestamps unchanged.

- [ ] **Step 5 — Run focused tests, generate schema docs, and commit.**

Run the focused tests, then the repository's documented Drizzle/schema generation command. Inspect generated DBML/PlantUML changes to ensure only the two generic columns appear.

```sh
git add src/db/schema/clinical.ts drizzle/0091_health_event_source_metadata.sql drizzle/meta/_journal.json docs/schema.dbml docs/schema.puml packages/server/src/routers/health-kit-sync-schemas.ts packages/server/src/repositories/health-kit-sync-repository.ts packages/server/src/repositories/health-kit-sync-repository.test.ts
git commit -m "feat: preserve HealthKit event metadata"
git push
```

## Task 3: Sync menstrual-flow samples from native HealthKit

**Files:**

- Modify `packages/mobile/modules/health-kit/ios/HealthKitTypes.swift`.
- Modify `packages/mobile/modules/health-kit/ios/HealthKitModule.swift`.
- Modify `packages/mobile/modules/health-kit/index.ts`.
- Modify `packages/mobile/modules/health-kit/Tests/HealthKitTypesTests.swift`.
- Modify or add the focused native query mapping XCTest next to existing module tests.
- Modify `packages/mobile/lib/health-kit-sync.ts`.
- Modify `packages/mobile/lib/health-kit-sync.test.ts`.
- Modify background-sync tests that enumerate `BACKGROUND_HEALTH_KIT_TYPES`.

- [ ] **Step 1 — Write failing permission and mapping tests.**

In `HealthKitTypesTests.swift`, require the menstrual flow identifier in both `readTypes` and `backgroundDeliveryTypes`, and require that it is absent from `writeTypes`.

In the TypeScript sync tests, add a sample with `metadata.HKMetadataKeyMenstrualCycleStart === true` and assert:

- full sync queries `HKCategoryTypeIdentifierMenstrualFlow` and uploads the unchanged metadata/source bundle;
- observer sync routes the type through anchored upload and deletion;
- anchor completion occurs only after upload/delete success;
- denied/not-determined authorization produces zero category samples without preventing already-authorized types from syncing.

- [ ] **Step 2 — Run native and TypeScript tests to confirm failure.**

Run the existing native module XCTest command documented in `packages/mobile/modules/health-kit/README.md`, plus:

```sh
pnpm vitest run packages/mobile/lib/health-kit-sync.test.ts packages/mobile/lib/background-health-kit-sync.test.ts
```

- [ ] **Step 3 — Add read/background permission without write permission.**

In `HealthKitTypes.swift`, append `.menstrualFlow` to the category types in `readTypes`, resolve the same category type into `backgroundDeliveryTypes`, and leave `writeTypes` unchanged.

Export this identifier from `health-kit-sync.ts`:

```ts
export const MENSTRUAL_FLOW_TYPE_IDENTIFIER = "HKCategoryTypeIdentifierMenstrualFlow";
```

Include it in `BACKGROUND_HEALTH_KIT_TYPES` and an `ANCHORED_SAMPLE_TYPES` set used by observer sync.

- [ ] **Step 4 — Generalize anchored reads to quantity and category samples.**

In Swift, resolve the type with a single helper:

```swift
func sampleType(for identifier: String) -> HKSampleType? {
    if let quantity = HKQuantityType.quantityType(
        forIdentifier: HKQuantityTypeIdentifier(rawValue: identifier)
    ) { return quantity }
    return HKCategoryType.categoryType(
        forIdentifier: HKCategoryTypeIdentifier(rawValue: identifier)
    )
}
```

Map quantity objects as today. Map `HKCategorySample` objects to the same transport envelope with `unit: "category"`, numeric `value`, UUID, timestamps, source name/bundle, and:

```swift
"metadata": [
    HKMetadataKeyMenstrualCycleStart:
        (sample.metadata?[HKMetadataKeyMenstrualCycleStart] as? NSNumber)?.boolValue ?? false
]
```

Use the helper in both `queryAnchoredSamples` and single-type `enableBackgroundDelivery`, changing invalid-type messages from “quantity type” to “sample type.” Retain the two-phase anchor contract and deletion UUIDs.

- [ ] **Step 5 — Add full-sync category querying.**

Add `metadata?: Record<string, string | number | boolean>` to `HealthKitSample`, and expose `queryCategorySamples()` from the TypeScript native wrapper and `HealthKitAdapter`.

In `syncHealthKitToServer()`, query menstrual flow over the same sync window, filter against the device-erasure cutoff, and upload through the existing raw-sample batch mutation. Do not rename the public tRPC mutation in this change; it already routes unknown sample types to `health_event` and renaming it would create unrelated API churn.

Rename the private `syncAnchoredQuantityType()` helper to `syncAnchoredSampleType()` and send menstrual-flow observer deliveries through it. Existing deletion routing must remove `fitness.health_event` rows by `hk:<uuid>`.

- [ ] **Step 6 — Run focused tests and commit.**

Run the native and TypeScript tests from Step 2, then:

```sh
git add packages/mobile/modules/health-kit/ios/HealthKitTypes.swift packages/mobile/modules/health-kit/ios/HealthKitModule.swift packages/mobile/modules/health-kit/index.ts packages/mobile/modules/health-kit/Tests packages/mobile/lib/health-kit-sync.ts packages/mobile/lib/health-kit-sync.test.ts packages/mobile/lib/background-health-kit-sync.test.ts
git commit -m "feat: sync HealthKit menstrual flow"
git push
```

Only stage background test files that actually changed.

## Task 4: Preserve cycle-start metadata in Apple Health XML imports

**Files:**

- Modify `src/providers/apple-health/records.ts`.
- Modify `src/providers/apple-health/records.test.ts` or the existing colocated parsing test.
- Modify `src/providers/apple-health/streaming.ts`.
- Modify `src/providers/apple-health/streaming.test.ts`.
- Modify `src/providers/apple-health/import.ts`.
- Modify `src/providers/apple-health/import.integration.test.ts`.

- [ ] **Step 1 — Write failing parser and import tests.**

Add two minimal XML fixtures:

```xml
<Record type="HKCategoryTypeIdentifierMenstrualFlow" sourceName="Cycle Source" sourceVersion="1" unit="count" creationDate="2026-08-01 08:05:00 -0700" startDate="2026-08-01 08:00:00 -0700" endDate="2026-08-01 08:05:00 -0700" value="HKCategoryValueMenstrualFlowMedium">
  <MetadataEntry key="HKMenstrualCycleStart" value="1"/>
</Record>
```

and a subsequent flow sample with the same type but cycle-start value `0`. Assert the streaming callback receives record-local metadata on the correct category only. In the real-Postgres import test, assert only the raw rows are stored, with source name and metadata, and a repeated import does not duplicate them.

- [ ] **Step 2 — Run the focused tests to confirm failure.**

```sh
pnpm vitest run src/providers/apple-health/records.test.ts src/providers/apple-health/streaming.test.ts
pnpm test:integration -- src/providers/apple-health/import.integration.test.ts
```

Use the existing parsing test filename if this checkout names it `parsing.test.ts`.

- [ ] **Step 3 — Model category source and metadata.**

Extend `CategoryRecord` with:

```ts
sourceBundle: string | null;
metadata: Record<string, string>;
```

Parse `sourceName`, optional `sourceBundle`/bundle identifier when present, dates, and value from the record attributes. In the SAX parser, keep a `currentCategory` until `</Record>`, collect nested `MetadataEntry` values into that record, then batch it. Do not reuse workout metadata state.

Normalize the Apple export key `HKMenstrualCycleStart` to canonical stored metadata:

```ts
metadata: {
  HKMetadataKeyMenstrualCycleStart: record.metadata.HKMenstrualCycleStart === "1",
}
```

Preserve other category metadata as strings so the generic raw event stays faithful.

- [ ] **Step 4 — Make XML event identity deterministic and collision-resistant.**

Add a production helper used by import insertion that creates the external ID from the raw identity tuple:

```ts
createHash("sha256")
  .update(JSON.stringify([
    record.type,
    record.sourceBundle,
    record.sourceName,
    record.value,
    record.startDate.toISOString(),
    record.endDate.toISOString(),
    record.metadata,
  ]))
  .digest("hex")
```

Prefix it with `ah-category:`. Write `sourceBundle` and normalized metadata into `health_event`. Do not change external IDs for numeric records or workouts.

- [ ] **Step 5 — Run focused tests and commit.**

```sh
git add src/providers/apple-health/records.ts src/providers/apple-health/records.test.ts src/providers/apple-health/streaming.ts src/providers/apple-health/streaming.test.ts src/providers/apple-health/import.ts src/providers/apple-health/import.integration.test.ts
git commit -m "feat: import Apple cycle start metadata"
git push
```

Adjust the staged test filename to the actual colocated file; do not create duplicate parsing suites.

## Task 5: Add the read-only cycle domain and tRPC queries

**Files:**

- Restore and rewrite `packages/scoring/src/menstrual-cycle.ts`.
- Restore and update `packages/scoring/src/menstrual-cycle.test.ts`.
- Modify `packages/scoring/package.json` and `packages/scoring/README.md`.
- Add `packages/server/src/repositories/menstrual-cycle-repository.ts`.
- Add `packages/server/src/repositories/menstrual-cycle-repository.test.ts`.
- Add `packages/server/src/repositories/menstrual-cycle-repository.integration.test.ts`.
- Add `packages/server/src/routers/menstrual-cycle.ts`.
- Add `packages/server/src/routers/menstrual-cycle.test.ts`.
- Modify `packages/server/src/router.ts` and `packages/server/src/router.test.ts`.
- Modify `packages/server/README.md`.

- [ ] **Step 1 — Restore phase computation with failing boundary tests.**

Restore the pure `CyclePhase`, `computePhase`, `PHASE_DISPLAY`, and `CYCLE_TRACKING_SAFETY_NOTICE` module from the commit before PR #2523. Retain tests for phase boundaries and invalid/stale handling used by the repository. Restore the `./menstrual-cycle` package export for production server and client imports.

- [ ] **Step 2 — Write failing repository integration fixtures.**

Seed `fitness.health_event` rows with:

```ts
type: "HKCategoryTypeIdentifierMenstrualFlow",
metadata: { HKMetadataKeyMenstrualCycleStart: true },
providerId: "apple_health",
sourceName: "Cycle Source",
sourceBundle: "com.example.cycle-source",
```

Exercise all active behavior:

- exact-date rows from two sources become one `CycleStart` containing both sources;
- a flow sample whose cycle-start metadata is false is not evidence;
- timezone conversion uses `ctx.timezone` before producing `YYYY-MM-DD`;
- three completed 21–35-day intervals with variation at most 9 days produce a phase estimate;
- fewer than three intervals returns `sparse-history`;
- out-of-range/irregular intervals return `irregular-history`;
- stale latest history returns `stale-history`;
- distinct starts fewer than 21 days apart return `conflicting-history` and no estimate;
- another user's events never appear.

- [ ] **Step 3 — Implement the read model contract.**

Use these production domain types:

```ts
export interface CycleSource {
  providerId: string;
  sourceName: string | null;
  sourceBundle: string | null;
}

export interface CycleStart {
  id: string;
  startDate: string;
  sources: CycleSource[];
}

export type CycleEstimateStatus =
  | "no-history"
  | "sparse-history"
  | "irregular-history"
  | "conflicting-history"
  | "stale-history"
  | "estimated";
```

`CycleStart.id` is server-derived as `cycle-start:<YYYY-MM-DD>` and is display identity only. It is never accepted by a mutation.

Query raw rows with:

```sql
WHERE user_id = $user
  AND type = 'HKCategoryTypeIdentifierMenstrualFlow'
  AND metadata ->> 'HKMetadataKeyMenstrualCycleStart' = 'true'
  AND start_date >= $range_start
  AND start_date < $range_end
```

Convert `start_date` to a local calendar date with the validated request timezone, then group exact dates in TypeScript and sort source attribution deterministically by provider ID, bundle, and name. Detect any adjacent distinct starts whose gap is less than `MINIMUM_REGULAR_CYCLE_DAYS`; return `conflicting-history` and name the two dates in the server-authored availability label.

Use the existing conservative rules: at least three completed cycles; range 21–35 days; maximum variation 9 days; no estimate beyond average cycle length plus seven days. Update unavailable labels to say “provider records” and “correct the record in its source and sync again,” never “log” or “edit.” Include the latest cycle-start sources in `CurrentPhaseResult`.

- [ ] **Step 4 — Add only read procedures.**

The router must contain exactly two positive capabilities:

```ts
export const menstrualCycleRouter = router({
  currentPhase: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .output(currentPhaseOutputSchema)
    .query(({ ctx }) =>
      new MenstrualCycleRepository(ctx.db, ctx.userId, ctx.timezone).getCurrentPhase(),
    ),
  history: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ months: z.number().int().min(1).max(24).default(6) }))
    .output(z.array(cycleStartOutputSchema))
    .query(({ ctx, input }) =>
      new MenstrualCycleRepository(ctx.db, ctx.userId, ctx.timezone).getHistory(input.months),
    ),
});
```

Register it as `menstrualCycle` in the root router and add it to the existing router assembly test. Do not import cache invalidation or `protectedProcedure` mutations.

- [ ] **Step 5 — Run focused unit/integration tests and commit.**

```sh
pnpm vitest run packages/scoring/src/menstrual-cycle.test.ts packages/server/src/repositories/menstrual-cycle-repository.test.ts packages/server/src/routers/menstrual-cycle.test.ts packages/server/src/router.test.ts
pnpm test:integration -- packages/server/src/repositories/menstrual-cycle-repository.integration.test.ts
```

Then:

```sh
git add packages/scoring/src/menstrual-cycle.ts packages/scoring/src/menstrual-cycle.test.ts packages/scoring/package.json packages/scoring/README.md packages/server/src/repositories/menstrual-cycle-repository.ts packages/server/src/repositories/menstrual-cycle-repository.test.ts packages/server/src/repositories/menstrual-cycle-repository.integration.test.ts packages/server/src/routers/menstrual-cycle.ts packages/server/src/routers/menstrual-cycle.test.ts packages/server/src/router.ts packages/server/src/router.test.ts packages/server/README.md
git commit -m "feat: add read-only cycle queries"
git push
```

## Task 6: Restore the web cycle route as a read-only view

**Files:**

- Add `packages/web/src/routes/cycle.tsx`.
- Add `packages/web/src/routes/cycle.test.tsx`.
- Modify generated `packages/web/src/routeTree.gen.ts` through the route generator.
- Modify `packages/web/src/pages/MorePage.tsx`, `packages/web/src/pages/MorePage.test.tsx`, and `packages/web/src/pages/MorePage.stories.tsx`.
- Modify `packages/web/src/pages/settingsCategories.ts` only if the existing data-source/privacy search needs `cycle` keywords.

- [ ] **Step 1 — Write failing positive rendering tests.**

Mock only `menstrualCycle.currentPhase` and `menstrualCycle.history`. Cover:

- an estimated phase with the server's phase/day/method/uncertainty/limitation labels;
- provider-attributed cycle starts with multiple sources on an exact-date duplicate;
- `no-history` and HealthKit permission guidance;
- `conflicting-history` with no phase graphic;
- server errors rendered from `error.message`;
- links to data sources, export, and account deletion/privacy settings.

Delete inherited mutation test cases instead of converting them to absence assertions.

- [ ] **Step 2 — Run focused tests to confirm failure.**

```sh
pnpm vitest run packages/web/src/routes/cycle.test.tsx packages/web/src/pages/MorePage.test.tsx
```

- [ ] **Step 3 — Implement the render-only route.**

Build the route from the former page's layout and presentation components, but limit its state to the two queries. It may format ISO dates and select `PHASE_DISPLAY` colors, but it must render every numeric/interpretive label from `currentPhase.data`.

Use copy with this meaning:

```text
Cycle records come from connected providers. To correct a date, update it in the source app and sync again.
```

Always show `CYCLE_TRACKING_SAFETY_NOTICE`. History rows show `sourceName`, falling back to `sourceBundle`, then `providerId`. Empty-state actions link to provider/permission settings and privacy/export; there is no form, date input, notes input, button that creates data, or mutation hook.

Add a “Cycle tracking” destination to `MorePage` with `/cycle`. Generate `routeTree.gen.ts` with the normal TanStack route generator/build command; do not hand-maintain generated route declarations.

- [ ] **Step 4 — Run focused tests, web typecheck/build, and commit.**

```sh
pnpm vitest run packages/web/src/routes/cycle.test.tsx packages/web/src/pages/MorePage.test.tsx
pnpm --dir packages/web typecheck
pnpm --dir packages/web build
```

Then:

```sh
git add packages/web/src/routes/cycle.tsx packages/web/src/routes/cycle.test.tsx packages/web/src/routeTree.gen.ts packages/web/src/pages/MorePage.tsx packages/web/src/pages/MorePage.test.tsx packages/web/src/pages/MorePage.stories.tsx packages/web/src/pages/settingsCategories.ts
git commit -m "feat: restore read-only web cycle view"
git push
```

Only stage `settingsCategories.ts` if it changed.

## Task 7: Restore the iOS cycle route as a read-only view

**Files:**

- Add `packages/mobile/app/cycle.tsx`.
- Add `packages/mobile/app-tests/cycle.test.tsx`.
- Add `packages/mobile/app-stories/cycle.stories.tsx`.
- Modify `packages/mobile/app/_layout.tsx`.
- Modify `packages/mobile/app/more.tsx` and `packages/mobile/app-tests/more.test.tsx`.
- Modify `packages/mobile/app/settings.tsx` and `packages/mobile/app-tests/settings.test.tsx` only for navigation/search keywords if needed.

- [ ] **Step 1 — Write failing mobile rendering tests.**

Mirror the web behavior at the mobile route boundary: estimated state, provider-attributed exact-date grouping, neutral no-provider-data/permission guidance, conflict state, and surfaced query errors. Assert navigation actions reach data sources and privacy/export. Delete former mutation scenarios rather than asserting removed UI is missing.

- [ ] **Step 2 — Run focused tests to confirm failure.**

```sh
pnpm vitest run packages/mobile/app-tests/cycle.test.tsx packages/mobile/app-tests/more.test.tsx packages/mobile/app-tests/settings.test.tsx
```

- [ ] **Step 3 — Implement the render-only Expo route.**

Reuse shared scoring labels/colors and existing mobile `QueryStatePanel`/error helpers. The screen contains only query state, the server-authored estimate or availability message, safety notice, provider-attributed start history, and navigation links. Use `Pressable` only for navigation/refresh; do not add local health-data state, text/date inputs, alerts for mutations, mutation telemetry, or query invalidation after writes.

Register `cycle` in the root `Stack`, add a “Cycle tracking” destination to `more.tsx`, and include the read-only screen in Storybook with populated, no-data, conflict, and error fixtures.

- [ ] **Step 4 — Run focused tests, mobile typecheck, and commit.**

```sh
pnpm vitest run packages/mobile/app-tests/cycle.test.tsx packages/mobile/app-tests/more.test.tsx packages/mobile/app-tests/settings.test.tsx
pnpm --dir packages/mobile typecheck
```

Then:

```sh
git add packages/mobile/app/cycle.tsx packages/mobile/app-tests/cycle.test.tsx packages/mobile/app-stories/cycle.stories.tsx packages/mobile/app/_layout.tsx packages/mobile/app/more.tsx packages/mobile/app-tests/more.test.tsx packages/mobile/app/settings.tsx packages/mobile/app-tests/settings.test.tsx
git commit -m "feat: restore read-only mobile cycle view"
git push
```

Only stage settings files if they changed.

## Task 8: Document provider support and verify the complete feature

**Files:**

- Modify `README.md` only if the feature catalog names cycle tracking.
- Modify `packages/mobile/README.md` and `packages/server/README.md` where HealthKit/cycle behavior is documented.
- Modify `docs/provider-api-audit.md` and `docs/roadmap.md` to state implemented and gated providers.
- No further production code expected unless validation reveals a directly related defect.

- [ ] **Step 1 — Update human documentation with primary citations.**

Document:

- Apple Health/HealthKit as the implemented read-only source, including menstrual-flow cycle-start metadata and authorization ambiguity;
- Garmin Women's Health as the best cloud follow-up, gated on Connect Developer Program approval and official payload access;
- Android Health Connect as a future Android-client source;
- WHOOP/Oura/Fitbit/Polar/Withings/Google Health as unsupported for explicit menstrual records under their current public APIs;
- the permanent absence of first-party period writes and the instruction to correct source data upstream.

Use the primary URLs already cited in the approved design. Do not claim production deployment or provider approval.

- [ ] **Step 2 — Run static removal and integrity checks.**

Run:

```sh
rg -n "logPeriod|updatePeriod|deletePeriod|fitness\.menstrual_period|Log a period|Edit period|Delete period" packages src
rg -n "HKCategoryTypeIdentifierMenstrualFlow|HKMetadataKeyMenstrualCycleStart" packages src
git diff --check
```

The first search may find historical docs/tests only where intentionally discussing removal; it must find no active procedure, repository writer, schema table, or input copy. The second must show native permission, sync, raw storage, XML import, repository read, and tests.

- [ ] **Step 3 — Run focused and changed-scope validation.**

Run:

```sh
pnpm lint
pnpm typecheck
pnpm test:changed:all
```

Also run the HealthKit XCTest suite, the focused PostgreSQL integration tests from Tasks 4–5, the web build, and the mobile typecheck. If Docker disk pressure blocks required tests, clean only current-workspace disposable resources and rebuildable cache per `docs/testing.md`; preserve other workspaces' containers and volumes.

- [ ] **Step 4 — Inspect the final diff and behavior.**

Verify:

- migration `0091` is forward-only and does not recreate manual storage;
- raw events keep upstream UUID/source/metadata and exact deletion behavior;
- only explicit cycle-start markers enter the cycle read model;
- current phase is suppressed for conflict, sparse, irregular, and stale states;
- web/mobile contain no first-party health-data input;
- both clients show matching evidence, source attribution, safety copy, and privacy paths;
- no breathwork files or other removed manual-health features were restored;
- `paseo.json` remains untouched and uncommitted.

- [ ] **Step 5 — Commit docs/final corrections and push.**

```sh
git add README.md packages/mobile/README.md packages/server/README.md docs/provider-api-audit.md docs/roadmap.md
git commit -m "docs: document cycle tracking providers"
git push
```

Only include files actually changed. If validation produces no corrections beyond documentation, this is the final implementation commit.

## Self-Review Checklist

- [ ] Every approved design section maps to a task: raw storage (2), native HealthKit (3), XML import (4), server reads (5), web/iOS parity (6–7), provider documentation and verification (8).
- [ ] No plan step restores `fitness.menstrual_period`, a manual export, a cycle mutation, or breathwork.
- [ ] HealthKit read/background support never adds menstrual flow to write authorization.
- [ ] Metadata types agree across Swift bridge, mobile TypeScript, Zod, repository interface, Drizzle JSONB, and XML import.
- [ ] Source attribution agrees across storage, query output, web, and mobile.
- [ ] TDD order is explicit for every behavior change, with real PostgreSQL execution for database semantics.
- [ ] Removed behavior is deleted without adding absence-only tests.
- [ ] Every third-party behavior claim in human documentation cites a primary source.
- [ ] Commands contain no placeholder filenames, branch switches, destructive resets, raw Docker Compose, production writes, or historical recovery actions.
- [ ] Every commit is pushed and the unrelated untracked `paseo.json` is preserved.
