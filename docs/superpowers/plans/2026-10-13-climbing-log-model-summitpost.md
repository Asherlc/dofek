# Shared climbing log model and SummitPost implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing climbing-entry model with the approved shared climbing log model and import all verified signed-log categories from SummitPost profile `182146`.

**Architecture:** User/provider-owned Area and Climb rows hold current object definitions; ClimbingLogEntry and ClimbingAttempt hold recorded experiences. One transactional writer serves existing providers and SummitPost, while server projections serve both clients. A coordinated maintenance cutover converts existing data before removing the old storage and application contracts.

**Tech Stack:** TypeScript, existing Drizzle ORM and Zod, native PostgreSQL `point`, Vitest, MSW, React web, Expo mobile; verified latest stable Cheerio only after the source-fixture gate.

**Spec:** [Approved model and source requirements](../specs/2026-10-13-climbing-log-model-summitpost-design.md).

## Global Constraints

- Canonical entities/ORM exports are `Area`/`area`, `Climb`/`climb`, `ClimbingLogEntry`/`climbingLogEntry`, and `ClimbingAttempt`/`climbingAttempt`.
- Relations are `fitness.area`, `fitness.climb`, `fitness.climbing_log_entry`, `fitness.climbing_attempt`, and `fitness.v_climbing_log_entry`.
- Climb owns `name`, `kind`, `grade`, `gradeSystem`, `setting`, `areaId`, and its `coordinates`; Area owns its name, parent, and point.
- ClimbKind: `boulder | route | summit`; ClimbSetting: `indoor | outdoor`; ClimbingDiscipline: `rock_climbing | hiking | scrambling | mountaineering`.
- ClimbingMethod: `lead | top-rope | follow | solo | aid`; the approved log field remains `climbStyle`.
- AttemptOutcome: `completed | failed`; `clean`, `receivedBeta`, and actual `attemptIndex` are independently nullable.
- Reuse the existing nine `CLIMBING_GRADE_SYSTEMS` values; retain nullable grades, source dates, and classifications without fabricated defaults.
- GpsCoordinates is `{ latitude, longitude }`; PostgreSQL `point` uses `x = longitude`, `y = latitude`, finite latitude -90..90 and longitude -180..180; zero is valid.
- Share objects only through verified source identity within the same owner/provider; names alone do not establish identity.
- Updated shared names, grades, containment, and coordinates apply to historical logs; derive `areaPath` on the server.
- Source count N creates N recorded attempts; absent count creates one recorded occurrence; never assert history completeness or derive actual order from import order.
- Explicit Onsight supplies completed/clean/beta=false/index=1; Flash supplies beta=true only with no other retained history on the verified Climb, excluding its own log.
- No Area kind, failure reason, completeness field, firstTry flag, duplicate grade/location/outcome/count storage, or normalized result label.
- Preserve log/attempt UUIDs, raw payloads, source occurrence identities, tombstones, and independently recorded dates; delete Activity links without deleting logs.
- Existing Mountain Project/OpenBeta outdoor assumptions become unknown unless verified source evidence establishes setting.
- Update all writers/readers, web/mobile, lifecycle inventories, and active docs; keep no runtime aliases, parallel stores, or compatibility endpoints.
- Preserve deployed migration SQL/journal identities and dated evidence; bounded conversion runs outside schema-only deployment migrations.
- No branch switching, production cutover, external metadata refresh, new environment variable, or spatial dependency is authorized by this plan alone.
- Prefix shell commands with `rtk`; use the workspace Compose/test wrappers; push each green commit automatically.

## Review Focus

1. A count-only record gains details and later omits them: resync preserves UUIDs and known facts without adding the count twice (Task 4, real PostgreSQL).
2. Equal source IDs under different owners/providers and concurrent opposite parent changes: isolation holds and a cycle cannot commit (Tasks 3–4, real PostgreSQL).
3. A Flash is resynced or imported beside prior history, and dated records arrive out of order: self-history is excluded, beta follows the agreed condition, and unknown actual order stays null (Task 4).
4. A public-profile provider has logs but no ClickHouse statistics row: counts, nullable rows, and full record details remain available on web/mobile (Tasks 8–9).
5. An attached source-dated log outlives a soft-deleted or physically deleted Activity: its date, Climb, and attempts survive with a null link (Tasks 3 and 6).

---

## Execution and commit boundaries

Stay on `add-summitpost-provider` in the current isolated workspace. Read each touched directory's AGENTS.md and sibling README before editing it. The source-fixture gate is independent of shared-model work: investigate it early, but do not invent SummitPost selectors or register a placeholder provider while access is unresolved.

Task 1 and Task 2 can produce independent green commits. Tasks 3–10 form one application/schema cutover: review and run focused tests at each task boundary, then commit and push them together after every consumer compiles and the complete acceptance suite passes. Do not introduce aliases to make intermediate work compile, or commit a broken intermediate version. Task 11 can then be committed independently. Task 12 performs the final whole-branch review and records validation.

Before every implementation push, run `rtk pnpm lint`, `rtk pnpm typecheck`, `rtk pnpm --recursive --if-present typecheck`, and the affected unit/mobile/integration tests. Commit only this task's files; push the existing branch with `rtk git push origin add-summitpost-provider`. A passing fixture sync is not proof that the connecting user's live profile was synced.

## File and responsibility map

| Responsibility | Files |
| --- | --- |
| Shared entity/enumeration/coordinate schemas | Create `packages/training/src/climbing-log.ts`, `gps-coordinates.ts`, and colocated tests; update `climbing-context.ts`, `climbing-grades.ts`, `climbing-filters.ts`, `climbing-progression.ts`, and `README.md`. Existing wildcard package exports already cover these modules. |
| Canonical persistence | Create `src/db/schema/climbing.ts`, `src/db/climbing-log-sync.ts`, `src/db/climbing-log-model-conversion.ts`; update `schema/activity.ts`, `schema/enums.ts`, `drizzle-schema.ts`, `index.ts`, `drizzle.config.ts`, and database test helpers. |
| Forward cutover | Add `drizzle/0146_climbing_log_model_prepare.sql`, `0147_climbing_log_model_finalize.sql`, matching generated snapshots/journal entries, `scripts/migrate-climbing-log-model.ts`, and `docs/climbing-log-model-cutover.md`. Recheck the journal head before allocating numbers. |
| Existing provider adapters | Update `src/providers/mountain-project.ts`, `openbeta.ts`, `thecrag.ts`, `kaya-sync.ts`, `kaya/import.ts`, `kaya/provider.ts`, and `packages/kaya-client/src/client.ts`; retain provider-specific source contracts in their existing owning modules. |
| Connection semantics | Update `src/providers/types.ts`, `provider-model.ts`, auth policy tests, `mountain-project.ts`, `openbeta.ts`, `ultrahuman.ts`, `wger.ts`, `thecrag.ts`, `packages/server/src/routers/token-auth.ts`, and `src/account-erasure/remote-snapshot.ts`. |
| Log contracts/association | Update `packages/server/src/contracts/climbing-context-contracts.ts`, `routers/climbing.ts`, `repositories/activity-repository.ts`, `climbing-source-links.ts`; rename `climbing-activity-entry-repository.ts` to `climbing-activity-log-entry-repository.ts` and `climbing-entry-associator.ts` to `climbing-log-entry-associator.ts`, including their tests/imports. |
| Rock analytics | Update server `repositories/climbing-repository.ts`, `climbing-progression-repository.ts`, `climbing-grade-display.ts`, `climbing-grade-progression.ts`, `climbing-training-log-repository.ts`, `performance-comparison-{repository,identity,context,types,modality-metrics,result,equivalence}.ts`, `analytical-training-load-repository.ts`, mobile-training service/contracts, and affected `mcp/` climbing/activity/performance tools. |
| Provider browsing/counts | Update server `repositories/provider-detail-repository.ts`, `sync-repository.ts`, `routers/provider-detail.ts`, `routers/sync.ts`; update `packages/providers-meta/src/provider-stats.ts` and both clients' provider records, details, and statistics components. |
| Lifecycle | Update `src/export.ts`, `src/db/provider-data-deletion.ts`, `src/account-erasure/postgres-erasure.ts`, `src/db/account-erasure.ts`, and executable export/deletion/erasure tests. |
| Both clients | Update web activity/training/provider pages and climbing components; mobile `app/activity/[id].tsx`, `app/(tabs)/strain.tsx`, `app/providers/[id].tsx`, climbing/provider components, route tests under `app-tests/`, and stories under `app-stories/`. Rename components representing the superseded entry model to `ClimbingLogEntry*` and `UnattachedClimbingLogEntries`. |
| SummitPost adapter | Create `src/providers/summitpost.ts`, `summitpost.test.ts`, `summitpost-sync.integration.test.ts`, verified HTML under `src/providers/fixtures/summitpost/`, and `docs/summitpost.md`; update catalog, worker/server registrations, package export, queue policy, and processing datasets. |
| Active documentation/retirement | Update `docs/schema.md`, `climbing-context.md`, provider guides, `adding-a-provider.md`, `docs/README.md`, `src/db/README.md`, `src/providers/README.md`, shared-package READMEs, generated `schema.dbml`/`schema.puml`; remove obsolete attempt-count backfill modules/tests/script/command. |

## Task 1: Shared model and GPS value

**Files:** Create the two shared modules/tests in the map; modify `packages/training/README.md`. Keep existing consumers intact until the coordinated cutover; do not add aliases.

**Interfaces:** Produce Zod schemas and inferred types `GpsCoordinates`, `Area`, `Climb`, `ClimbingLogEntry`, `ClimbingAttempt`, `ClimbKind`, `ClimbSetting`, `ClimbingDiscipline`, `ClimbingMethod`, and `AttemptOutcome` from the approved fields. Export the corresponding lower-camel `*Schema` values and arrays `CLIMB_KINDS`, `CLIMB_SETTINGS`, `CLIMBING_DISCIPLINES`, `CLIMBING_METHODS`, and `ATTEMPT_OUTCOMES`. `ClimbingAttempt` includes its persisted `createdAt`; log lifecycle/context fields match the spec. Import the grade-system catalog from `climbing-grades.ts`.

- [ ] Write `gps-coordinates.test.ts` cases named `accepts zero and signed boundary coordinates` and `rejects incomplete nonfinite and out-of-range pairs`; write `climbing-log.test.ts` cases named `accepts an undated ungraded summit with unknown attempt facts` and `validates recognized grades while preserving unknown systems`.

  ```ts
  expect(gpsCoordinatesSchema.parse({ latitude: 0, longitude: 0 })).toEqual({ latitude: 0, longitude: 0 });
  expect(gpsCoordinatesSchema.safeParse({ latitude: 90.01, longitude: 0 }).success).toBe(false);
  expect(attemptOutcomeSchema.options).toEqual(["completed", "failed"]);
  expect(climbSchema.parse(ungradedSummit).gradeSystem).toBeNull();
  ```

- [ ] Run `rtk pnpm test:unit -- packages/training/src/gps-coordinates.test.ts packages/training/src/climbing-log.test.ts`; expect missing-module/schema failures.
- [ ] Implement the shared schemas/types with nullable recorded facts, trimmed nonempty supplied text, positive nullable attemptIndex, and existing context validation. Recognized grade systems require a valid grade using `isValidClimbingGrade`; unknown system may accompany recorded text.
- [ ] Run the same tests and all training package typechecks; expect PASS.
- [ ] Review field ownership against the approved UML, run pre-push checks, commit `feat: define shared climbing log entities`, and push.

## Task 2: Public-profile connection and erasure semantics

**Files:** Connection files in the map plus `provider-model.test.ts`, provider auth policy tests, server `token-auth.test.ts`, `remote-snapshot.integration.test.ts`, web `DataSourcesAuthModals.tsx`/tests, and mobile provider `auth-modals.tsx`/tests.

**Interfaces:** Add required `ProviderAuthSetup.manualToken.kind: "public-profile" | "access-token"`; change `ProviderAuthCapabilities.manualToken` to that union or null; add `"public-profile"` to `ProviderAuthType`. Preserve `tokenAuth.connect({ providerId: string, token: string })` and `exchangeToken(token: string): Promise<TokenSet>` as the single form/storage flow. Public-profile classification is capability metadata, not another token field or remote credential.

- [ ] Write tests named `classifies profile identity separately from access tokens` and `persists public profile identity through the existing connect form`: Mountain Project/OpenBeta classify as public-profile, theCrag/wger/Ultrahuman as token, and public input uses text. Seed existing connections in real PostgreSQL for `snapshots public profiles without remote authorization`.

  ```ts
  expect(classifyProviderAuth({ automatedLogin: false, manualToken: "public-profile", oauth1: false, oauth: false })).toBe("public-profile");
  expect(snapshot.providerConnections).toContainEqual({ providerId: "mountain-project", disposition: "no_remote_authorization" });
  expect(storedIdentity.providerAccountId).toBe("182146"); // A public-profile test provider returns this identity; the real SummitPost adapter comes later.
  ```

- [ ] Run `rtk pnpm test:unit -- src/providers/provider-model.test.ts src/providers/provider-auth-policy-unit.test.ts packages/server/src/routers/token-auth.test.ts`; expect auth-contract failures. Run the remote snapshot integration through `rtk pnpm test:integration -- src/account-erasure/remote-snapshot.integration.test.ts` and expect the public-profile snapshot failure.
- [ ] Implement the required discriminator at every declaration/capability/schema consumer, preserve auth precedence, reuse existing web/mobile form behavior, and branch erasure on verified provider capability instead of treating every stored identity as revocable authorization. Existing connections need no token rewrite.
- [ ] Run the affected auth tests, real snapshot integration, web modal tests, and mobile `app-tests/providers/auth-modals.test.tsx` using `rtk pnpm test:mobile --`; expect PASS.
- [ ] Review connection and erasure behavior, run pre-push checks, commit `feat: distinguish public profile connections`, and push.

## Task 3: Canonical schema and executable database constraints

**Files:** Schema/registration files in the map; create `src/db/climbing-log-model.integration.test.ts`; rename/update `unattached-climbing-entry.integration.test.ts` to `unattached-climbing-log-entry.integration.test.ts`. Add preparation/finalization migrations and generated metadata, without changing deployed files.

**Interfaces:** ORM exports from `src/db/schema/climbing.ts` match Task 1. Enum exports/SQL names are `climbKindEnum`/`climb_kind`, `climbSettingEnum`/`climb_setting`, `climbingDisciplineEnum`/`climbing_discipline`, `climbingMethodEnum`/`climbing_method`, and `climbingAttemptOutcomeEnum`/`climbing_attempt_outcome`; retain `climbingGradeSystemEnum`/`climbing_grade_system`. Consume Task 1 catalogs instead of duplicating values. Native points use `point("coordinates", { mode: "xy" })`. Composite unique owner/provider/id keys support scoped parent, area, and climb foreign keys. Activity references use `(user_id, activity_id)` with `ON DELETE SET NULL (activity_id)` in SQL, retaining nonnullable ownership. Nullable attemptIndex is actual order, so remove the old per-log slot uniqueness rule.

- [ ] Write real-engine tests named `round trips native points and nullable source facts`, `rejects cross-owner and cross-provider object references`, and `preserves source date and attempts after physical activity deletion`. Create the graph and execute invalid FK/coordinate inserts against PostgreSQL.

  ```ts
  expect(storedPoint).toEqual({ x: -122.25, y: 37.5 });
  expect(zeroPoint).toEqual({ x: 0, y: 0 });
  expect(afterActivityDelete).toMatchObject({ id: logId, activityId: null, climbedOn: "2026-10-01" });
  expect(attemptIdsAfterDelete).toEqual(attemptIdsBeforeDelete);
  await expect(crossOwnerClimbReference).rejects.toThrow();
  await expect(insertPointOutsideBounds).rejects.toThrow();
  ```

- [ ] Run `rtk pnpm test:integration -- src/db/climbing-log-model.integration.test.ts src/db/unattached-climbing-log-entry.integration.test.ts`; expect missing canonical tables/columns or incorrect deletion behavior.
- [ ] Implement final ORM/enums and schema-only SQL: preparation creates Area/Climb and conversion columns while old clients are stopped; finalization validates conversion, renames log/FK/constraints/indexes, removes superseded columns/view/helper functions/failure enum, and installs the canonical projection. Point checks reject nonfinite/range violations at the engine boundary. Scope all object FKs and index user/provider/date and parent/reference lookups.
- [ ] Exercise the final schema on a fresh empty database and run the tests; expect PASS. Do not confuse a fresh schema pass with a populated upgrade pass, which belongs to Task 10.
- [ ] Review ownership, nullable facts, and native point SQL; retain this task's changes for the coordinated commit after Task 10.

## Task 4: Atomic source-object and attempt reconciliation

**Files:** Create `src/db/climbing-log-sync.ts` and `climbing-log-sync.integration.test.ts`; replace `climbing-entry-sync.ts` and its tests; update `src/db/index.ts`, `src/providers/test-helpers.ts`, and every affected SyncDatabase stub.

**Interfaces:** Require `SyncDatabase.transaction: Database["transaction"]`, reusing the existing TransactionDatabase callback/configuration contract; real Database/TransactionDatabase satisfy it. Produce `persistClimbingLogEntries(db: SyncDatabase, input: ClimbingLogSyncInput): Promise<{ logEntryIds: string[]; recordsSynced: number }>`.

`ClimbingLogSyncInput` contains `{ userId: string; providerId: string; entries: readonly SourceClimbingLogEntry[] }`. Define and export source-input types in this writer for provider consumers:

- `SourceAreaDefinition`: nullable verified externalId, required name, optional coordinates; an ordered array supplies broadest-to-nearest containment.
- `SourceClimbDefinition`: nullable verified externalId; optional name/kind/grade/gradeSystem/setting/coordinates and optional `areas: readonly SourceAreaDefinition[]`.
- `SourceAttemptFacts`: optional attemptIndex/outcome/clean/receivedBeta/notes using Task 1 types.
- `SourceClimbingLogEntry`: required qualified externalId; optional Climb definition, activityId, climbedOn, discipline, climbStyle, title, notes, sourceName, board, wallAngle, routeProtection, holdType, raw; input-only optional `reportedAttemptCount`, `attempts: readonly SourceAttemptFacts[]`, and `qualifier: "onsight" | "flash" | "clean-send" | "fell-hung"`.

An omitted property means unsupplied and preserves known state; explicit null means a verified clearing of a nullable property. `areas: []` explicitly clears containment; absent areas preserves it. Source qualifiers/counts never become canonical extra columns. Authoritative session-list tombstoning remains a separate session-scoped policy; it is not attempt completeness.

- [ ] Write real PostgreSQL tests named `expands count summaries without duplicating tries on resync`, `uses one recorded occurrence when count is absent`, `preserves known facts when later responses omit them`, `rejects a count below described evidence`, `excludes self history from flash beta inference`, and `keeps completion cleanliness and actual order independent`.

  ```ts
  expect(countOnlyAttempts).toHaveLength(4);
  expect(countOnlyAttempts.map(a => [a.attemptIndex, a.outcome, a.clean, a.receivedBeta])).toEqual(Array(4).fill([null, null, null, null]));
  expect(noCountAttempts).toHaveLength(1);
  expect(idsAfterResync).toEqual(idsBeforeResync);
  expect(detailedAttemptAfterOmission).toMatchObject({ id: originalAttemptId, outcome: "completed", clean: true, receivedBeta: false });
  expect(onsight).toMatchObject({ outcome: "completed", clean: true, receivedBeta: false, attemptIndex: 1 });
  expect(flashAfterSelfResync).toMatchObject({ receivedBeta: true, attemptIndex: 1 });
  expect(flashWithOtherHistory).toMatchObject({ receivedBeta: null, attemptIndex: 1 });
  expect(fellHung).toMatchObject({ outcome: null, clean: false });
  expect(unknownOrder.map(a => a.attemptIndex)).toEqual([null, null]);
  await expect(countBelowDescribedTries).rejects.toThrow("recorded attempts");
  ```

- [ ] Add real tests named `reuses local objects only through the same occurrence`, `updates historical displays from shared definitions`, `removes replaced unreferenced local chains`, `rolls back all graph writes when a batch entry is invalid`, and `serializes opposite reparentings to reject a concurrent cycle`, using existing `createTestBarrier`/`hasDatabaseLockWaiter` helpers. Include equal source IDs/names in different scopes and metadata omission.

  ```ts
  expect(historicalLog.climb.grade).toBe("5.11a");
  expect(historicalLog.climb.areaPath.map(a => a.name)).toEqual(["Updated region", "Updated crag"]);
  expect(afterOmittedMetadata).toMatchObject({ name: "Known climb", coordinates: { x: -122.25, y: 37.5 } });
  expect(remainingLogsAfterRejectedBatch).toEqual(logsBeforeBatch);
  expect(parentUpdates.filter(r => r.status === "rejected")).toHaveLength(1);
  ```

- [ ] Run `rtk pnpm test:integration -- src/db/climbing-log-sync.integration.test.ts`; expect missing writer or reconciliation failures.
- [ ] Implement the writer using a transaction and a transaction advisory lock keyed by user/provider before resolving/updating the graph. Check proposed ancestry recursively under that same lock. Match verified object keys or the existing log association; never match unrelated names. Resolve all batch occurrences before qualifier inference so entry iteration order does not change the other-history check. Update supplied facts only; retain child UUIDs; add unknown rows to reach the supplied count and remove only surplus fully unknown rows on a verified count correction. Reject contradictory counts or ambiguous individual-try matching rather than deleting described evidence. Preserve existing explicit attempts; internal stable row matching must not become actual attemptIndex. A source qualifying only one try updates its matched described try, not every count row.
- [ ] Run reconciliation tests plus affected provider unit tests with required transaction stubs; expect PASS without optional transaction guards or type assertions masking missing capabilities.
- [ ] Review rollback, source identity, cycle serialization, and Flash self-exclusion; retain changes for the coordinated commit.

## Task 5: Move existing providers and imports to the common writer

**Files:** Existing adapter/client files in the map and their colocated tests; `mountain-project-sync.integration.test.ts`, `openbeta-sync.integration.test.ts`, `thecrag-sync.integration.test.ts`, `kaya/import.integration.test.ts`; create `src/providers/kaya-sync.integration.test.ts` using PostgreSQL and MSW.

**Interfaces:** Consume Task 4 source-input types and writer. Keep `sync(run: SyncRun): Promise<SyncResult>`. Occurrence keys remain distinct from source Climb IDs; namespace session-scoped KAYA occurrence IDs with immutable upstream session identity before applying a uniform owner/provider/externalId unique key.

- [ ] Adapt provider tests with named cases `keeps repeated occurrences separate on one verified climb`, `maps source counts and qualifiers to attempts`, `stores coordinates on the located object`, and `uses verified setting evidence`. Add `preserves records after incomplete session discovery` and `tombstones only absent records from an authoritative complete session`. Cover KAYA summary/send identity and CSV missing object IDs.

  ```ts
  expect(repeatedClimbLogs).toHaveLength(2);
  expect(new Set(repeatedClimbLogs.map(l => l.climbId)).size).toBe(1); // Verified source object ID.
  expect(kayaSummaryAttempts).toHaveLength(4);
  expect(csvClimbsWithoutIds.map(c => c.externalId)).toEqual([null, null]);
  expect(unverifiedOutdoorClimb.setting).toBeNull();
  expect(gymPointOwner).toBe("area");
  ```

- [ ] Run focused provider unit/client tests and `rtk pnpm test:integration -- src/providers/mountain-project-sync.integration.test.ts src/providers/openbeta-sync.integration.test.ts src/providers/thecrag-sync.integration.test.ts src/providers/kaya-sync.integration.test.ts src/providers/kaya/import.integration.test.ts`; expect old-contract/count/coordinate failures.
- [ ] Normalize each source independently into the common input. Preserve Mountain Project/theCrag cursor and occurrence rules. Verify OpenBeta tick.climbId versus nested climb.uuid namespace before reuse; select documented Climb lat/lng and containing Area centers separately. Verify KAYA actual Climb identity instead of treating compound attempted-record ID as object identity; expand coordinates only where a verified contract allows. Use known gym evidence for indoor; omit provider-wide outdoor defaults. Recover missing source date/context only from verified raw or session data, preserving its meaning.
- [ ] Replace every direct old-table writer, preserve transaction boundaries for activity/session operations and authoritative list handling, and run the same provider suites; expect PASS.
- [ ] Review provider identity/mapping independently of generic persistence and retain changes for the coordinated commit. Unverified source fields stay null; do not request external refresh as part of this task.

## Task 6: Generic log projection, attachments, and deletion

**Files:** Contract/log repository/associator/router files in the map; relevant unit/integration tests and `activity-repository.integration.test.ts`.

**Interfaces:** Produce `ClimbingLogEntryDetail` from `climbingLogEntryDetailSchema`: shared log fields, `climb: (Climb & { areaPath: Area[] }) | null`, `attempts: ClimbingAttempt[]`, `recordedAttemptCount: number`, `recordedOutcome: AttemptOutcome | null`, `rockResultLabels: Array<"sent" | "Onsight" | "Flash">`, nullable display grade, and existing server-built sourceLinks. Rename repository method to `ClimbingActivityLogEntryRepository.getActivityLogEntries(activityId: string): Promise<ClimbingActivityLogEntry[]>`; wrapper `toDetail(): ClimbingLogEntryDetail`. Router procedures become `activityLogEntries({ activityId: string })`, `unattachedClimbingLogEntries({ activityId: string })`, and `attachClimbingLogEntry({ climbingLogEntryId: string, activityId: string })`. Associator methods are `getSuggestions(activityId: string): Promise<ClimbingLogEntrySuggestion[]>` and `attachLogEntry(input: { climbingLogEntryId: string; activityId: string }): Promise<void>`; rename corresponding suggestion schema/cache keys.

- [ ] Write PostgreSQL tests named `projects unknown dates grades and results independently`, `traverses the current nearest-recorded area chain`, `attaches eligible hiking and mountaineering logs without erasing source date`, and `unlinks logs transactionally during single and bulk soft deletion`. Include cross-user rejection and independent completion/clean labels.

  ```ts
  expect(genericSummit).toMatchObject({ climbedOn: null, recordedAttemptCount: 1, recordedOutcome: "completed" });
  expect(genericSummit.climb).toMatchObject({ grade: null, gradeSystem: null });
  expect(afterAttach.climbedOn).toBe("2026-10-01");
  expect(afterSoftDelete).toMatchObject({ activityId: null, climbedOn: "2026-10-01" });
  expect(genericSummit.rockResultLabels).toEqual([]); // Completion alone supplies no rock qualifier.
  ```

- [ ] Create `climbing-activity-log-entry-repository.integration.test.ts` and run `rtk pnpm test:integration -- packages/server/src/repositories/climbing-activity-log-entry-repository.integration.test.ts packages/server/src/repositories/climbing-log-entry-associator.integration.test.ts packages/server/src/repositories/activity-repository.integration.test.ts`; expect contract/association failures. Run `rtk pnpm test:unit -- packages/server/src/repositories/climbing-activity-log-entry-repository.test.ts packages/server/src/repositories/climbing-log-entry-associator.test.ts` to expose the changed contracts in existing tests.
- [ ] Implement recursive current-hierarchy projection and attempt aggregation in PostgreSQL, coordinate conversion at the server boundary, nullable grade/date handling, and server-derived rock labels only with established facts. `recordedOutcome` is completed when any recorded attempt completed, failed only when all recorded attempts explicitly failed, otherwise null. Sort established actual indices first, ascending, with nulls last and deterministic ties; no tie-breaker writes an actual index. Preserve query-time cross-provider repeat selection. Source links receive accessible provider/object/log labels and fixed allowed origins. Unlink source logs inside the same transaction as soft-deleting Activity members; use same-user validation and compatible activity-type gates.
- [ ] Run projection/association/activity/router tests; expect PASS for both graded rock records and nullable generic logs.
- [ ] Review entity versus display ownership and deletion behavior; retain changes for the coordinated commit.

## Task 7: Rock analytics, training exposure, and MCP

**Files:** Rock analytics/mobile-training/MCP files in the map, shared climbing filters/context/grade/progression modules, `packages/format/src/climbing-context.ts` and `format.ts`, and their existing unit/integration suites.

**Interfaces:** Consume canonical projection/Climb fields. Rename generic `climbType`/`ClimbingClimbType` to `climbKind`/`RockClimbKind` in rock DTOs and grade helper signatures (`gradeSystemsForClimbKind`, `isGradeSystemForClimbKind`); rock kind is only `boulder | route`. Filters independently expose kind, discipline, climbStyle, protection, and nullable Climb setting. Keep the numerical fields clients already render, computed by server queries.

- [ ] Write tests named `filters rock eligibility before grade conversion in both query branches`, `excludes summit completion from clean rock send metrics`, `preserves repeated-observation selection and known-rock participation`, and `filters source-evidenced setting without provider defaults`. Seed attached/standalone graded and ungraded rock, technical-grade summit completion, unclassified entries, repeated observations, known gym setting, and unknown setting.

  ```ts
  expect(rockVolume.sends).toBe(1);
  expect(rockVolume.recordedAttempts).toBe(3);
  expect(progression.map(p => p.grade)).toEqual(["5.10a"]);
  expect(unknownSettingLog.climb.setting).toBeNull();
  expect(comparison.performances[0]?.metrics.climbing).toMatchObject({ attempts: 3, sends: 1 });
  ```

- [ ] Run `rtk pnpm test:integration -- packages/server/src/repositories/climbing-repository.integration.test.ts packages/server/src/repositories/climbing-progression-repository.integration.test.ts packages/server/src/repositories/performance-comparison-repository.integration.test.ts packages/server/src/repositories/analytical-training-load-repository.integration.test.ts` and affected shared/MCP unit tests; expect old names/eligibility failures.
- [ ] Join current Climb grade/setting, derive source counts/outcomes from attempts, apply known rock eligibility before conversion in both query branches, retain ungraded known-rock participation and existing repeat matching, and update mobile dashboard output validation. Remove duplicated mobile strict schema definitions in favor of the shared response schema. Update every MCP contract/output consumer and snapshot around the final model.
- [ ] Run the same integration suites plus `mobile-dashboard.integration.test.ts`, shared training/format tests, and climbing/performance MCP tests; expect PASS. Assert the established pre-cutover rock fixture metrics remain equal apart from the explicitly approved setting change.
- [ ] Review clean versus completed semantics and server metric ownership; retain changes for the coordinated commit.

## Task 8: Provider log records, full details, and counts

**Files:** Provider browse/count files in the map, provider-detail/sync router contracts, provider metadata tests, `provider-detail-repository.integration.test.ts`, `provider-stats-read-model.integration.test.ts`, and `sync-repository.integration.test.ts`.

**Interfaces:** Add `climbingLogEntries` to available-data-type/statistics contracts, with UI label `Climbing log`. Existing `providerDetail.records` returns server-curated concise columns; `providerDetail.recordDetail({ providerId, dataType: "climbingLogEntries", recordId })` returns full `ClimbingLogEntryDetail` and opaque provenance. Provider counts merge indexed PostgreSQL totals with existing statistics, including providers absent from ClickHouse results.

- [ ] Write tests named `serves log-only provider counts without a ClickHouse stats row`, `orders dated logs before stable undated logs`, and `loads complete owned log details independently of list columns`. Seed nullable Climb, updated hierarchy/point, and other-user rows; assert available data types, scope and filters.

  ```ts
  expect(sourceOnlyProviderStats.climbingLogEntries).toBe(3);
  expect(availableTypes).toContain("climbingLogEntries");
  expect(rows.map(r => r.id)).toEqual([newestDatedId, olderDatedId, undatedId]);
  expect(detail).toMatchObject({ notes: "Recorded source note", climb: { coordinates: { latitude: 37.5, longitude: -122.25 } } });
  expect(detail.sourceLinks).toHaveLength(2);
  ```

- [ ] Run the provider-detail/stats/sync integrations through `rtk pnpm test:integration --` with the exact files above; expect missing type/count/detail failures.
- [ ] Implement the data type, typed detail projection, curated list columns, null-aware sort/filter logic, and indexed per-user/provider log counts merged through the existing shared statistics path. Keep details out of list rows; do not add a ClickHouse/dbt read model.
- [ ] Run affected repository/router/metadata tests; expect PASS with no sensor rows for the fixture provider.
- [ ] Review list/detail boundaries and scope enforcement; retain changes for the coordinated commit.

## Task 9: Web/mobile model and interaction parity

**Files:** Web `pages/ActivityDetailPage.tsx`, `pages/activity-detail/components/ClimbingLogEntry{Breakdown,Context,Sources}.tsx`, `UnattachedClimbingLogEntries.tsx`, `routes/training/climbing.tsx`, climbing charts/toggles, `pages/provider-detail-data.tsx`, `RecordDetailModal.tsx`, `ProviderDetailPage.tsx`, and ProviderStatsBreakdown. Mobile routes/components listed in the map, `ClimbingTrainingCard.tsx`, `ClimbingFilters.tsx`, provider detail modal/record formatting/statistics, and colocated or `app-tests/` tests/stories.

**Interfaces:** Both clients consume Tasks 6–8 response schemas without calculating metrics. Both selected-record modals call `providerDetail.recordDetail` for the selected provider/data type/record ID. Generic record copy is `Climbing log`; details render source date, current Climb grade/path/point, recorded attempts/outcomes, notes, and source links as text.

- [ ] Write matching web/mobile tests named `browses nullable generic climbing logs`, `fetches full details for a selected concise row`, `keeps cached records visible during refetch`, `renders actionable server errors and accessible source links`, and `attaches an eligible hiking log`. Adapt rock chart/filter tests to canonical kind/setting/grade contracts.

  ```ts
  expect(screen.getByText("Climbing log")).toBeVisible();
  expect(recordDetailInput).toEqual({ providerId: "summitpost", dataType: "climbingLogEntries", recordId: selectedId });
  expect(screen.getByText("Recorded source note")).toBeVisible();
  expect(screen.getByText("Source date unknown")).toBeVisible();
  expect(screen.getByText(actionableServerMessage)).toBeVisible();
  expect(screen.getByText("Recorded summit")).toBeVisible(); // Assert before and during the pending background refetch.
  ```

- [ ] Run `rtk pnpm test:unit -- packages/web/src/pages/ActivityDetailPage.test.tsx packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.test.tsx packages/web/src/pages/activity-detail/components/UnattachedClimbingLogEntries.test.tsx packages/web/src/routes/training/climbing.test.tsx packages/web/src/pages/provider-detail-data.test.tsx packages/web/src/pages/RecordDetailModal.test.tsx` and `rtk pnpm test:mobile -- 'packages/mobile/app-tests/activity/[id].test.tsx' 'packages/mobile/app-tests/providers/[id].test.tsx' 'packages/mobile/app-tests/(tabs)/strain.test.tsx'`; expect old contract or missing detail behavior failures.
- [ ] Replace old model interfaces/component names/imports, render nullable facts explicitly, wire details to the endpoint, keep cached rows, and update setting filters and activity attachment controls. Shared formatting only formats already computed data. Update both platforms' Storybook fixtures for partial/unknown/error/refetch states; put mobile helpers/tests outside `app/`.
- [ ] Run matching web/mobile suites and typechecks; expect PASS. Visually inspect web and mobile stories with available browser/runtime tooling. For each HTTP development server, start `/Users/asherlc/bin/paseo-quick-tunnel <port>` for its entire lifetime and report only its emitted HTTPS trycloudflare URL.
- [ ] Review parity, screen-reader labels, and concise lists; retain changes for the coordinated commit.

## Task 10: Bounded conversion, lifecycle coverage, and complete cutover

**Files:** Create `src/db/climbing-log-model-conversion.ts`, `climbing-log-model-conversion.integration.test.ts`, `scripts/migrate-climbing-log-model.ts`, `scripts/migrate-climbing-log-model.test.ts`, `docs/climbing-log-model-cutover.md`; update migrations from Task 3 and lifecycle files/tests, including `src/db/account-erasure.integration.test.ts`. Create `src/export.integration.test.ts` and `src/account-erasure/postgres-erasure.integration.test.ts`. Retire `scripts/backfill-climbing-attempt-count.ts`, `src/db/climbing-attempt-count-backfill.ts`, its tests, and package command.

**Interfaces:** Produce `inspectClimbingLogConversion(db: Database): Promise<ClimbingLogConversionReport>`, `convertClimbingLogBatch(db: Database, batchSize: number): Promise<{ converted: number; remaining: number }>`, and `validateClimbingLogConversion(db: Database): Promise<ClimbingLogConversionReport>`. Report `{ inspected: number; conflicts: Array<{ climbingLogEntryIds: string[]; providerId: string; externalId: string | null; field: string; message: string }> }`. CLI subcommands are `inspect`, `prepare`, `convert`, `validate`, `finalize`; conversion accepts a positive `--batch-size` with default 100. Use existing DATABASE_URL handling; no new environment variable.

- [ ] Write populated PostgreSQL tests named `preserves legacy identity provenance and recorded facts`, `rejects unresolved shared object definition conflicts before conversion`, `resumes conversion after a committed batch`, `rejects finalization while legacy rows remain unconverted`, and `installs the final model on a fresh empty database`. Include verified identity/coordinate recovery and identical chain reconciliation.

  ```ts
  expect(convertedLog.id).toBe(legacyLogId);
  expect(convertedAttempt.id).toBe(legacyAttemptId);
  expect(convertedLog.climbedOn).toBe("2026-10-01");
  expect(unknownLegacyDate).toBeNull();
  expect(report.conflicts[0]).toMatchObject({ field: "grade", externalId: verifiedClimbId });
  expect(resumedResult.remaining).toBe(0);
  await expect(finalizeWithUnconvertedRows).rejects.toThrow("unconverted");
  ```

- [ ] Write real tests named `exports the complete owned climbing graph`, `deletes one providers climbing graph without deleting other-source activities`, `rejects stale-generation graph writes after deletion`, and `covers and erases all climbing graph tables`. Include point values and public-profile no-authorization snapshots.

  ```ts
  expect(exportFiles).toEqual(expect.arrayContaining(["areas.csv", "climbs.csv", "climbing-log-entries.csv", "climbing-attempts.csv"]));
  expect(exportedClimb.coordinates).toBe("(-122.25,37.5)");
  expect(otherProviderActivityAfterDeletion.id).toBe(otherProviderActivityId);
  await expect(assertPostgresAccountErasureCoverage(db)).resolves.toBeUndefined();
  await expect(staleGenerationWrite).rejects.toThrow();
  ```

- [ ] Run `rtk pnpm test:integration -- src/db/climbing-log-model-conversion.integration.test.ts src/export.integration.test.ts src/db/provider-data-deletion.integration.test.ts src/account-erasure/postgres-erasure.integration.test.ts src/account-erasure/remote-snapshot.integration.test.ts` and `rtk pnpm test:unit -- scripts/migrate-climbing-log-model.test.ts`; expect missing conversion or lifecycle inventory failures.
- [ ] Implement inspection and bounded transactions using a temporary preparation-stage conversion marker on each legacy log. Validate the complete inventory before conversion; source definition conflicts need verified current metadata/source timestamps, never creation-time precedence. Preserve existing attempt UUIDs and source facts, recover actual order only from verified evidence, expand counts idempotently, and mark a row converted in its transaction. Unrepresentable evidence fails preflight. Resumption selects unconverted rows; no long-lived checkpoint or shadow entity store remains after finalization.
- [ ] Implement CLI migration sequencing using an operator-local temporary migration-directory prefix through preparation: copy exactly registered prefix SQL files, original prefix journal entries/timestamps, and complete `_history` so existing integrity checks hold. Call existing `runMigrations(databaseUrl, migrationsDir)` rather than modifying deploy's apply-all runner. `prepare` applies only that prefix; `convert` commits bounded batches; `validate` checks canonical coverage and contradictions; `finalize` validates and applies the full tracked directory. Detect already-finalized state before attempting an earlier prefix. Preserve legacy outcome/order columns separately during preparation until conversion establishes canonical nullable facts; drop them only at finalization. Finalization checks unconverted rows and essential target invariants, removes temporary markers/obsolete storage, and installs final constraints/projection. Inspect is read-only; operator commands require the documented quiesced window.
- [ ] Update export/deletion/erasure ownership joins, inventories, write fences, and coverage assertions. Export canonical entities to `areas.csv`, `climbs.csv`, `climbing-log-entries.csv`, and `climbing-attempts.csv`, following the existing hyphenated plural filename convention; serialize each native point once. Implement provider deletion in dependency order without deleting associated other-source Activities. Remove obsolete backfill commands and code completely.
- [ ] Update all active docs listed in the map with source citations; document the breaking maintenance sequence, deploy coordination, backup/restore boundary, source-conflict preflight, approved setting change, and no automatic external refresh. Generate final diagrams with `rtk pnpm schema:diagram`; verify Drizzle snapshots match the final schema.
- [ ] Run all Tasks 3–10 focused suites, full lint, root and recursive package typechecks, migration policy/SQL lint, and diff review. Search active code/docs for obsolete names, allowing only actual upstream vocabulary, dated historical records, and upgrade fixtures. Do not add tests asserting the absence of removed names. Expect every current consumer to compile and every behavior suite to pass.
- [ ] Review the whole coordinated cutover, commit `refactor: unify climbing log storage and clients`, and push. Do not run the production cutover; supply the tested concrete runbook for final operator authorization.

## Task 11: Verified SummitPost discovery and provider

**Files:** SummitPost files/registrations in the map; `packages/providers-meta/src/provider-catalog.ts`, `src/jobs/provider-registration.ts`, `packages/server/src/routers/sync-helpers.ts`, root `package.json` provider export, `src/jobs/provider-queue-config.ts`, `src/processing/dataset-contracts.ts`, and both platforms' connection/provider tests.

**Interfaces:** Export only the production provider class `SummitPostProvider` implementing the existing Provider contract, `validate`, auth setup, and `sync(run: SyncRun): Promise<SyncResult>`. Its manual connection kind is public-profile. Persist numeric profile identity `182146` through the existing token repository. Use Task 4's common writer; occurrence keys contain verified object/log IDs, Climb identity is the verified object ID, and each repeated log stays separate.

- [ ] Obtain permitted ordinary-browser access or owner-supplied saved HTML for the actual profile, all signed-log pagination layouts, individual logs, actual object categories, repeats, missing fields, and replies. Record URL/capture date/author/object/log IDs and expected records in a fixture manifest; strip cookies and unrelated private content while retaining structure. Reject search snippets as parser evidence. If this input is unavailable, stop only adapter implementation and explain the missing prerequisite; shared-model work remains independently executable.
- [ ] Check the current stable Cheerio release, official license, release/security evidence, and existing dependency inventory. Pin the latest stable version only if no canonical installed parser already serves this requirement; cite sources in `docs/summitpost.md`. Do not guess selectors or bypass source access restrictions.
- [ ] Write provider unit tests through the public class named `accepts only SummitPost profile URLs with numeric identity`, `discovers every verified signed-log page`, `imports the connected authors entries and excludes replies`, `preserves repeated logs and independently unknown fields`, `stores verified object coordinates`, and `reports malformed pages and transport failures with the source URL`. Include explicit climbed date versus posting date, unknown labels, and hostile note markup. Private parser functions remain private.

  ```ts
  expect(connectedIdentity.providerAccountId).toBe("182146");
  expect(importedLogs.map(l => l.externalId)).toEqual(expectedManifestOccurrenceIds);
  expect(repeatedObjectLogs).toHaveLength(2);
  expect(undatedLog.climbedOn).toBeNull();
  expect(ungradedLog.climb.grade).toBeNull();
  expect(partialListRetainedLogIds).toEqual(previousLogIds);
  expect(syncResult.errors[0].message).toContain(failingSourceUrl);
  ```

- [ ] Run `rtk pnpm test:unit -- src/providers/summitpost.test.ts`; expect missing provider/parser failures.
- [ ] Implement the isolated adapter using verified selectors and Zod validation, `createProviderRateLimitFetch`, and existing pagination/degradation/error/telemetry contracts. Traverse all verified signed-log pages without climbed-date filtering, restrict profile identity and same-origin discovery links, and normalize only the connected author's logs. Store title/notes independently of Climb name; keep unknown facts null; no fabricated Activity; do not tombstone from a missing or partial list.
- [ ] Write and run `rtk pnpm test:integration -- src/providers/summitpost-sync.integration.test.ts` with PostgreSQL and MSW serving the verified fixture pack. Assert all manifest IDs/categories, page-two discovery, repeats, resync identity, unknown attempts, coordinates, response failures, and retention on interrupted discovery. First verify the failure, then fix only the diagnosed mapping/persistence defect until PASS.
- [ ] Register the working provider in every catalog/worker/server/queue/dataset/export location, document the public-profile connection on both clients, and run provider/auth/record UI suites plus full pre-push checks.
- [ ] Review source-contract evidence and complete fixture traversal, commit `feat: sync SummitPost climbing logs`, and push. State precisely whether the supplied live profile was reached and synced; request missing saved-page input if it still prevents that acceptance criterion.

## Task 12: Final acceptance and independent whole-branch review

**Files:** Update checklist/validation records in this plan and active docs only when the implementation evidence warrants it.

**Interfaces:** The acceptance surface is one canonical model, all existing providers/imports, generic records, preserved rock analytics, both clients, full lifecycle, tested maintenance tooling, and verified SummitPost discovery. Production migration execution remains a separate operator action.

- [ ] Run the exact focused unit/mobile/integration suites accumulated by Tasks 1–11, full lint, root/all-package typechecks, and final migration/schema checks. Repeat tests only after a new change/failure; record commands and real outputs, not an unverified success claim.
- [ ] Request a fresh whole-branch review of source semantics, migration preservation/rollback boundaries, scoped hierarchy locks, nullable first-try facts, all lifecycle paths, and web/mobile parity. Fix substantive findings and rerun the affected checks before committing/pushing corrections.
- [ ] Verify the permitted profile traversal against its discovery inventory if source access is available, including every verified signed-log page and category. Record imported occurrence count and unknown-field behavior; do not label fixture-only testing as a live successful sync.
- [ ] Commit/push remaining reviewed documentation or fixes after required checks, and provide implementation status, verified tests, any source-access/production-cutover boundary, and the concrete reviewed runbook. Close with a short retrospective and propose a field-ownership checklist in the schema/provider guide if it would prevent future duplicate storage; recommend the integration-tests-ready skill for the next schema/provider change.

## Plan self-review

Checked against each section of the approved specification: entities/enums/points (1, 3), connection semantics (2), identity/hierarchy/attempt normalization (4–5), date/attachment/deletion (3, 6), generic serving/parity (8–9), rock/training/MCP consumers (7), conversion/lifecycle/cleanup/docs (10), source access/provider discovery (11), and acceptance (12). All five Review Focus cases have executable owning tests. Central tasks share the exact source-input/DTO names and one coordinated commit boundary; no production operation or source-access success is implied by plan approval.

Plan-only verification on 2026-10-13: `rtk pnpm lint`, `rtk pnpm typecheck`, and `rtk pnpm --recursive --if-present typecheck` passed. Lint retained the three existing SQLFluff large-file skips; this plan changes no source/configuration. No product tests were run for this documentation change. Implementation checkboxes remain pending user plan review and execution-method selection.
