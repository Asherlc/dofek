# Shared climbing log model and SummitPost implementation plan

<!-- cspell:words AICE AIDC belayer DBML Greenpoint IFAS NCCS NCCST preplaced reparenting summitpost trycloudflare unroped WICE -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing climbing-entry model with the approved shared climbing log model and import all verified signed-log categories from SummitPost profile `182146`.

**Architecture:** User/provider-owned Area, Climb, and Pitch rows hold current definitions and owned published grade components; ClimbingLogEntry owns separately reported grades and scoped ClimbingAttempt rows. One transactional writer serves existing providers and SummitPost, while server projections serve both clients. A coordinated maintenance cutover converts existing data before removing the old storage and application contracts.

**Tech Stack:** TypeScript, existing Drizzle ORM and Zod, native PostgreSQL `point`, Vitest, MSW, React web, Expo mobile; verified latest stable Cheerio only after the source-fixture gate.

**Spec:** [Approved model and source requirements](../specs/2026-10-13-climbing-log-model-summitpost-design.md).

**Revision status (2026-10-14):** The user approved the revised written spec.
The revised plan was approved and execution resumed. Preserve the
previously selected **Native** execution method. Task 2 remains complete and
pushed at `0fe6e38`; Task 1 and Tasks 3–5 require alignment with the new model.
Their previous test evidence describes the initial shape. Retain and adapt
that work rather than rebuilding unaffected behavior. No implementation edits
were part of the preceding plan revision.

## Global Constraints

- Canonical entities/ORM exports are `Area`/`area`, `Climb`/`climb`, `Pitch`/`pitch`, `ClimbingLogEntry`/`climbingLogEntry`, and `ClimbingAttempt`/`climbingAttempt`.
- Relations are `fitness.area`, `fitness.climb`, `fitness.pitch`, `fitness.climb_grade`, `fitness.pitch_grade`, `fitness.climbing_log_entry_grade`, `fitness.climbing_log_entry`, `fitness.climbing_attempt`, and `fitness.v_climbing_log_entry`.
- Climb owns name, kind, containment, setting, advertised `routeProtection`, coordinates, and `publishedGrades`; Pitch owns its source identity/number/name and `publishedGrades`; Log owns `reportedGrades`. Grade rows contain `value`, nullable `system`, one owner FK, and structural source order.
- ClimbKind: `boulder | route | summit`; ClimbSetting: `indoor | outdoor`; ClimbingDiscipline: `rock_climbing | ice_climbing | mixed_climbing | snow_climbing | hiking | scrambling | mountaineering`.
- AttemptScope: `climb | pitch`; RopeMethod: `lead | top_rope | follow | unroped`; ProtectionStyle: `sport | trad`; AttemptOutcome: `completed | failed`.
- GradeSystem: `v_scale | font | yds | french | uiaa | ewbank | saxon | norwegian | brazilian_crux | british_adjectival | british_technical | aid | water_ice | alpine_ice | mixed | ifas | nccs`.
- Attempt owns nullable `attemptIndex`, `outcome`, `ropeMethod`, `solo`, `protectionUsed`, `usedPreplacedProtection`, `usedAid`, `fellOrHung`, `dabbed`, `receivedBeta`, `hadCompletedBefore`, `priorFailedAttemptsGroundUp`, and notes. Null is unknown; aid alone never sets `fellOrHung`.
- Every attempt has a required scope. Whole-Climb attempts have no pitch or parent; a pitch attempt may identify a Pitch and reference a whole-Climb parent in the same log. Parent links are one level deep and require source evidence.
- Empty grade collections mean no recorded components. Omission preserves known components; an explicitly supplied collection replaces that owner's components, including an empty one. Catalogue changes never overwrite separately reported log grades.
- GpsCoordinates is `{ latitude, longitude }`; PostgreSQL `point` uses `x = longitude`, `y = latitude`, finite latitude -90..90 and longitude -180..180; zero is valid.
- Share objects only through verified source identity within the same owner/provider; names alone do not establish identity.
- Updated shared names, grades, containment, and coordinates apply to historical logs; derive `areaPath` on the server.
- Source count N creates N recorded attempts at its reported scope/target; absent count creates one recorded occurrence at its established scope. Explicit pitch results create no additional whole-Climb attempt. Catalogue pitches and a pitch-count field create no attempts.
- Count and derive outcomes separately by scope. Pitch completion never establishes whole-Climb completion; parent and child tries never count together in a whole-Climb total. Never assert history completeness or derive actual order from import order.
- Explicit free Onsight supplies completed/fellOrHung=false/usedAid=false/beta=false/index=1; a free boulder send also establishes dabbed=false. Flash supplies beta=true only with no other retained history on the same verified Climb/Pitch, excluding its own log and resolving the full incoming batch first.
- Aid Onsight/Flash establishes completion, aid use and first-try order, with the approved beta rule, but cannot establish fellOrHung=false. Free send requires completion and known absence of aid/falls/hangs and applicable dabs. Derived labels are server output only.
- No Area kind, failure reason, completeness field, firstTry flag, duplicate grade/location/outcome/count storage, or normalized result label.
- Preserve log/attempt UUIDs, raw payloads, source occurrence identities, tombstones, and independently recorded dates; delete Activity links without deleting logs.
- Existing Mountain Project/OpenBeta outdoor assumptions become unknown unless verified source evidence establishes setting.
- Update all writers/readers, web/mobile, lifecycle inventories, and active docs; keep no runtime aliases, parallel stores, or compatibility endpoints.
- Preserve deployed migration SQL/journal identities and dated evidence; bounded conversion runs outside schema-only deployment migrations.
- No branch switching, production cutover, external metadata refresh, new environment variable, or spatial dependency is authorized by this plan alone.
- Prefix shell commands with `rtk`; use the workspace Compose/test wrappers; push each green commit automatically.

## Review Focus

1. A count-only record gains details and later omits them, or includes pitch results: UUIDs/facts survive and counts reconcile within the same scope/target (Task 4, real PostgreSQL).
2. Equal source IDs under different owners/providers and concurrent opposite parent changes: isolation holds and a cycle cannot commit (Tasks 3–4, real PostgreSQL).
3. A Flash is synced again or imported beside history at another scope, and dates arrive out of order: target history and self-exclusion control beta; unknown actual order stays null (Task 4).
4. A public-profile provider has logs but no ClickHouse statistics row: counts, nullable rows, and full record details remain available on web/mobile (Tasks 8–9).
5. Multi-grade or pitch-only logs reach queries and conversion: grade joins never multiply tries, pitch results never become route completion, and reported grades survive catalogue changes (Tasks 4, 6–7 and 10). Activity deletion survival remains an explicit test in Tasks 3 and 6.

---

## Execution and commit boundaries

Stay on `add-summitpost-provider` in the current isolated workspace. Read each touched directory's AGENTS.md and sibling README before editing it. The source-fixture gate is independent of shared-model work: investigate it early, but do not invent SummitPost selectors or register a placeholder provider while access is unresolved.

Task 2 is already committed and pushed; do not redo it. The revised Task 1
and Tasks 3–10 form one application/schema cutover: run focused tests at each
task boundary, then commit and push together after every consumer compiles
and the complete acceptance suite passes. Do not introduce aliases or commit
a broken intermediate version. Keep this modeling cutover in draft PR
[#2942](https://github.com/Asherlc/dofek/pull/2942). Task 11 is separate provider
work after the verified-source gate; exclude it from the modeling PR. Task 12
performs the fresh whole-branch review for the deliverable being shipped.

Modeling delivery order is revised Task 1, Tasks 3–10, then Task 12's modeling
acceptance. Task 2 is already done. Task 11 follows independently when verified
source access is available, then receives Task 12's provider acceptance. Do
not block the modeling review or PR on the SummitPost source prerequisite.

Before every implementation push, run `rtk pnpm lint`, `rtk pnpm typecheck`, `rtk pnpm --recursive --if-present typecheck`, and the affected unit/mobile/integration tests. Commit only this task's files; push the existing branch with `rtk git push origin add-summitpost-provider`. A passing fixture sync is not proof that the connecting user's live profile was synced.

## File and responsibility map

| Responsibility | Files |
| --- | --- |
| Shared entity/enumeration/coordinate schemas | Revise `packages/training/src/climbing-log.ts`, retain `gps-coordinates.ts` and its passing tests; update `climbing-context.ts`, `climbing-grades.ts`, `climbing-filters.ts`, `climbing-progression.ts`, colocated tests, and `README.md`. Existing wildcard package exports already cover these modules. |
| Canonical persistence | Revise local `src/db/schema/climbing.ts`, `climbing-log-sync.ts`, `source-attempt-facts.ts`, and `climbing-log-session-sync.ts` with focused unit/real database tests; create `climbing-log-model-conversion.ts`; update `schema/activity.ts`, `schema/enums.ts`, `drizzle-schema.ts`, `index.ts`, `drizzle.config.ts`, and database test helpers. |
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

## Task 1: Revised shared entities, grades, and attempt facts

**Files:** Revise `packages/training/src/climbing-log.ts` and its tests;
update `climbing-grades.ts`, `climbing-grades.test.ts`, `climbing-context.ts`,
and `packages/training/README.md`. Retain the existing GPS module/tests.

**Interfaces:** Produce the approved `Area`, `Climb`, `Pitch`,
`ClimbingLogEntry`, `ClimbingAttempt`, `GradeComponent`, `ClimbKind`,
`ClimbSetting`, `ClimbingDiscipline`, `AttemptScope`, `RopeMethod`,
`ProtectionStyle`, `AttemptOutcome`, and `GradeSystem` types and corresponding
lower-camel `*Schema` exports. Retain `GpsCoordinates`. Enum catalogues are
`CLIMB_KINDS`, `CLIMB_SETTINGS`, `CLIMBING_DISCIPLINES`, `ATTEMPT_SCOPES`,
`ROPE_METHODS`, `PROTECTION_STYLES`, `ATTEMPT_OUTCOMES`, and `GRADE_SYSTEMS`.
GradeSystem and grade validation stay in `climbing-grades.ts`; conversion
uses a narrowed `FreeRockGradeSystem` covering the existing nine supported
systems, rather than treating every non-boulder grade as a free route grade.
Attempts retain `createdAt`; log experience/lifecycle fields follow the spec.

- [ ] Add failing model tests named `accepts pitch-only logs and independent attempt facts`, `retains multiple published and separately reported grade components`, and `keeps unknown systems with recorded text`. Extend grade-validation tests for the eight new systems using the approved source-defined examples, while retaining existing conversion tests.

  ```ts
  expect(gpsCoordinatesSchema.parse({ latitude: 0, longitude: 0 })).toEqual({ latitude: 0, longitude: 0 });
  expect(gpsCoordinatesSchema.safeParse({ latitude: 90.01, longitude: 0 }).success).toBe(false);
  expect(attemptOutcomeSchema.options).toEqual(["completed", "failed"]);
  expect(climbSchema.parse(ungradedSummit).publishedGrades).toEqual([]);
  expect(gradeComponentSchema.parse({ value: "source difficulty", system: null }).system).toBeNull();
  expect(leadSoloAttempt).toMatchObject({ scope: "climb", ropeMethod: "lead", solo: true, usedAid: null });
  expect(unidentifiedPitchAttempt).toMatchObject({ scope: "pitch", pitchId: null, parentAttemptId: null });
  expect(compoundClimb.publishedGrades).toEqual([{ value: "5.12a", system: "yds" }, { value: "A3", system: "aid" }]);
  expect(gradeComponentSchema.safeParse({ value: "WI4", system: "water_ice" }).success).toBe(true);
  expect(gradeComponentSchema.safeParse({ value: "5.12a", system: "water_ice" }).success).toBe(false);
  ```

- [ ] Run `rtk pnpm test:unit packages/training/src/gps-coordinates.test.ts packages/training/src/climbing-log.test.ts packages/training/src/climbing-grades.test.ts`; expect revised shape/grade-validation failures, with retained GPS behavior passing.
- [ ] Implement the approved schemas, enum catalogues and grade-component validation; preserve source text, nullable facts, positive nullable actual index, and existing context validation. Keep advertised protection on Climb and actual use on Attempt. Retire old shared method/scalar-grade/clean fields directly, without aliases. Validate new recorded systems against their primary-source scale definitions; retain the established conversion library for supported free grades rather than inventing cross-discipline conversions.
- [ ] Run the focused tests and `rtk pnpm test:unit packages/training/src`; expect PASS. Root/client compilation remains a coordinated-cutover gate after later consumers migrate.
- [ ] Self-review against the approved UML and retain changes for the coordinated commit after Task 10.

## Task 2: Public-profile connection and erasure semantics

**Status:** Complete and pushed at `0fe6e38`; preserve this implementation
and its recorded unit/mobile/PostgreSQL evidence. The steps below describe
completed work. Re-run affected coverage only when later integration changes
touch these consumers.

**Files:** Connection files in the map plus `provider-model.test.ts`, provider auth policy tests, server `token-auth.test.ts`, `remote-snapshot.integration.test.ts`, web `DataSourcesAuthModals.tsx`/tests, and mobile provider `auth-modals.tsx`/tests.

**Interfaces:** Add required `ProviderAuthSetup.manualToken.kind: "public-profile" | "access-token"`; change `ProviderAuthCapabilities.manualToken` to that union or null; add `"public-profile"` to `ProviderAuthType`. Preserve `tokenAuth.connect({ providerId: string, token: string })` and `exchangeToken(token: string): Promise<TokenSet>` as the single form/storage flow. Public-profile classification is capability metadata, not another token field or remote credential.

- [x] Write tests named `classifies profile identity separately from access tokens` and `persists public profile identity through the existing connect form`: Mountain Project/OpenBeta classify as public-profile, theCrag/wger/Ultrahuman as token, and public input uses text. Seed existing connections in real PostgreSQL for `snapshots public profiles without remote authorization`.

  ```ts
  expect(classifyProviderAuth({ automatedLogin: false, manualToken: "public-profile", oauth1: false, oauth: false })).toBe("public-profile");
  expect(snapshot.providerConnections).toContainEqual({ providerId: "mountain-project", disposition: "no_remote_authorization" });
  expect(storedIdentity.providerAccountId).toBe("182146"); // A public-profile test provider returns this identity; the real SummitPost adapter comes later.
  ```

- [x] Run `rtk pnpm test:unit src/providers/provider-model.test.ts src/providers/provider-auth-policy-unit.test.ts packages/server/src/routers/token-auth.test.ts`; expect auth-contract failures. Run the remote snapshot integration through `rtk pnpm test:integration src/account-erasure/remote-snapshot.integration.test.ts` and expect the public-profile snapshot failure.
- [x] Implement the required discriminator at every declaration/capability/schema consumer, preserve auth precedence, reuse existing web/mobile form behavior, and branch erasure on verified provider capability instead of treating every stored identity as revocable authorization. Existing connections need no token rewrite.
- [x] Run the affected auth tests, real snapshot integration, web modal tests, and mobile `app-tests/providers/auth-modals.test.tsx` using `rtk pnpm test:mobile`; expect PASS.
- [x] Review connection and erasure behavior, run pre-push checks, commit `feat: distinguish public profile connections`, and push.

## Task 3: Canonical schema and executable database constraints

**Files:** Schema/registration files in the map; create `src/db/climbing-log-model.integration.test.ts`; rename/update `unattached-climbing-entry.integration.test.ts` to `unattached-climbing-log-entry.integration.test.ts`. Add preparation/finalization migrations and generated metadata, without changing deployed files.

**Interfaces:** ORM exports from `src/db/schema/climbing.ts` match Task 1:
`area`, `climb`, `pitch`, `climbGrade`, `pitchGrade`, `climbingLogEntryGrade`,
`climbingLogEntry`, and `climbingAttempt`. Grade rows have one required owner
FK, `value`, nullable `system`, and `position` for supplied structural order;
no shared grade-catalogue table. Pitch inherits ownership through Climb.
Enum exports/SQL names are `climbKindEnum`/`climb_kind`,
`climbSettingEnum`/`climb_setting`, `climbingDisciplineEnum`/`climbing_discipline`,
`attemptScopeEnum`/`attempt_scope`, `ropeMethodEnum`/`rope_method`,
`protectionStyleEnum`/`protection_style`, `attemptOutcomeEnum`/`attempt_outcome`,
and `gradeSystemEnum`/`grade_system`, consuming Task 1 catalogues.
Native points use `point("coordinates", { mode: "xy" })`. Keep scoped
Area/Climb FKs. Parent-attempt FKs require the same log; engine checks/triggers
reject pitch targets outside the log's Climb, non-climb parents, or a whole
attempt with a pitch/parent. Activity references retain column-specific
`ON DELETE SET NULL (activity_id)` and required user ownership. Actual
attemptIndex has no per-log slot uniqueness rule.

- [ ] Extend real-engine tests with `stores ordered owned grade collections`, `rejects mismatched pitch targets and cross-log parents`, and `rejects nested pitch parents and whole-attempt pitch links`. Retain native-point, owner/provider isolation, and physical-Activity-deletion tests. Exercise insert and update paths directly against PostgreSQL.

  ```ts
  expect(storedPoint).toEqual({ x: -122.25, y: 37.5 });
  expect(zeroPoint).toEqual({ x: 0, y: 0 });
  expect(afterActivityDelete).toMatchObject({ id: logId, activityId: null, climbedOn: "2026-10-01" });
  expect(attemptIdsAfterDelete).toEqual(attemptIdsBeforeDelete);
  await expect(crossOwnerClimbReference).rejects.toThrow();
  await expect(insertPointOutsideBounds).rejects.toThrow();
  expect(climbGrades.map(g => [g.value, g.system, g.position])).toEqual([["5.12a", "yds", 0], ["A3", "aid", 1]]);
  await expect(pitchFromAnotherClimb).rejects.toThrow();
  await expect(parentFromAnotherLog).rejects.toThrow();
  await expect(pitchParentingPitch).rejects.toThrow();
  expect(validUnidentifiedPitch.scope).toBe("pitch");
  ```

- [ ] Run `rtk pnpm test:integration src/db/climbing-log-model.integration.test.ts src/db/unattached-climbing-log-entry.integration.test.ts`; expect new grade-table/scope-constraint failures.
- [ ] Revise only the uncommitted preparation/finalization SQL and snapshots to the final ORM/enums. Preparation creates the new entities/grade rows and conversion columns while old clients are stopped; finalization validates conversion, renames log/FK/constraints/indexes, removes superseded storage/types, and installs the canonical projection. Enforce scope/grouping both on attempt updates and on updates that could invalidate an existing graph. Retain native-point checks and scoped reference indexes. Never edit deployed migrations or journal identities.
- [ ] Exercise the final schema on a fresh empty database and run the tests; expect PASS. Do not confuse a fresh schema pass with a populated upgrade pass, which belongs to Task 10.
- [ ] Review ownership, nullable facts, and native point SQL; retain this task's changes for the coordinated commit after Task 10.

## Task 4: Atomic source-object and attempt reconciliation

**Files:** Revise local `src/db/climbing-log-sync.ts`,
`climbing-log-sync.integration.test.ts`, `source-attempt-facts.ts` and its
unit tests, `climbing-log-session-sync.ts` and its integration tests. Retire
`climbing-entry-sync.ts` and its tests after Task 5 migrates its callers.
Preserve the required transaction contract and typed unit stubs already added.

**Interfaces:** Require `SyncDatabase.transaction: Database["transaction"]`, reusing the existing TransactionDatabase callback/configuration contract; real Database/TransactionDatabase satisfy it. Produce `persistClimbingLogEntries(db: SyncDatabase, input: ClimbingLogSyncInput): Promise<{ logEntryIds: string[]; recordsSynced: number }>`.

`ClimbingLogSyncInput` contains `{ userId: string; providerId: string; entries: readonly SourceClimbingLogEntry[] }`. Define and export source-input types in this writer for provider consumers:

- `SourceAreaDefinition`: nullable verified externalId, required name, optional coordinates and optional `parentExternalId`; ordered areas supply broadest-to-nearest containment. Omitted parent evidence must not clear known ancestry.
- `SourcePitchDefinition`: nullable verified externalId; optional positive number, name, and `publishedGrades: readonly GradeComponent[]`. Pitch identity is a verified ID or verified source number within the identified Climb, never a name match.
- `SourcePitchReference`: `{ externalId?: string; number?: number }`, with at least one supplied verified key, resolved only within the log's Climb. Omit it for unidentified pitch scope.
- `SourceClimbDefinition`: nullable verified externalId; optional name/kind/setting/routeProtection/coordinates, `publishedGrades`, `areas: readonly SourceAreaDefinition[]`, and `pitches: readonly SourcePitchDefinition[]`. Supplied pitches upsert definitions; catalogue definitions alone create no attempts.
- `SourceAttemptFacts`: a partial selection of Task 1's actual index, outcome, method/solo/protection/aid/fall-hang/dab/beta/history facts and notes. Explicit false and supplied arrays count as described evidence.
- `SourceClimbingAttempt`: `SourceAttemptFacts` plus required `scope`, optional `pitch: SourcePitchReference`, optional input-only `sourceKey`/`parentSourceKey` for source-established one-level grouping, and optional qualifier. Correlation keys are structural input; never write them into attemptIndex or invent them as provider attempt identities.
- `SourceAttemptCount`: `{ scope: AttemptScope; pitch?: SourcePitchReference; count: number }`; positive actual-try counts apply only to that scope/target. Do not aggregate unrelated unidentified pitches into one identified target.
- `SourceClimbingLogEntry`: required qualified externalId and nonempty `attempts: readonly SourceClimbingAttempt[]`; optional Climb definition, activityId, climbedOn, discipline, title, notes, sourceName, board, wallAngle, holdType, raw, `reportedGrades`, and input-only `reportedAttemptCounts: readonly SourceAttemptCount[]`. An adapter represents a no-total occurrence as one explicit scoped attempt with unknown facts.

`SourceAttemptQualifier` is `free-onsight | free-flash | free-send | fell-hung | aid-onsight | aid-flash | dab`.
Revise `normalizeSourceAttemptFacts(facts: SourceAttemptFacts, qualifier:
SourceAttemptQualifier | undefined, context: { climbKind: ClimbKind | null;
targetIdentified: boolean; hasOtherTargetHistory: boolean }): SourceAttemptFacts`
in `source-attempt-facts.ts`. Its production caller is the common writer.
Other verified labels normalize to their independent supplied facts and an
applicable qualifier; preserve original labels in provenance.
`targetIdentified` requires established target identity, rather than a name
match; unidentified pitch tries retain unknown actual target order.

Retain `persistClimbingLogSessions(db: SyncDatabase, input:
ClimbingLogSessionsSyncInput)`, whose input has owner/provider,
`standaloneEntries`, and `sessions: readonly { activityId: string;
entries: readonly SourceClimbingLogEntry[]; complete: boolean }[]`.
It combines all entries into one writer batch inside the surrounding session
transaction; only complete session discovery authorizes absent-log tombstones.

An omitted property means not supplied and preserves known state; explicit null
means a verified clearing of a nullable property. `areas: []` explicitly clears
containment; absent areas preserves it. Supplied grade collections replace
only their owner's rows in supplied order, including an empty collection.
Source qualifiers/counts never become canonical extra columns. Match scoped
attempt details and parent links only with established evidence; reject
ambiguous individual matching instead of assigning details arbitrarily.

- [ ] Extend fact unit tests for free versus aid qualifiers, independent outcomes/falls/hangs, boulder sends/dabs, lead/top-rope solo, French-free aid without an inferred fall/hang, preplaced protection, and explicit Repeat/Ground-up history. Extend PostgreSQL tests named `reconciles count summaries within their target scope`, `keeps pitch-only logs free of synthetic whole tries`, `preserves every supplied fact during count correction`, and `evaluates Flash history on its exact target after resolving both batch orders`. Retain no-count/idempotency/rollback/cycle tests.

  ```ts
  expect(countOnlyAttempts).toHaveLength(4);
  expect(countOnlyAttempts.map(a => [a.attemptIndex, a.outcome, a.fellOrHung, a.usedAid])).toEqual(Array(4).fill([null, null, null, null]));
  expect(noCountAttempts).toHaveLength(1);
  expect(idsAfterResync).toEqual(idsBeforeResync);
  expect(detailedAttemptAfterOmission).toMatchObject({ id: originalAttemptId, outcome: "completed", fellOrHung: false, receivedBeta: false });
  expect(onsight).toMatchObject({ outcome: "completed", fellOrHung: false, usedAid: false, receivedBeta: false, attemptIndex: 1 });
  expect(flashAfterSelfResync).toMatchObject({ receivedBeta: true, attemptIndex: 1 });
  expect(flashWithOtherHistory).toMatchObject({ receivedBeta: null, attemptIndex: 1 });
  expect(fellHung).toMatchObject({ outcome: null, fellOrHung: true });
  expect(aidOnsight).toMatchObject({ outcome: "completed", usedAid: true, fellOrHung: null, receivedBeta: false, attemptIndex: 1 });
  expect(pitchOnlyAttempts.map(a => a.scope)).toEqual(["pitch", "pitch"]);
  expect(pitchFlashBesideWholeHistory.receivedBeta).toBe(true);
  expect(pitchFlashBesideSamePitchHistory.receivedBeta).toBeNull();
  expect(unknownOrder.map(a => a.attemptIndex)).toEqual([null, null]);
  await expect(countBelowDescribedTries).rejects.toThrow("recorded attempts");
  ```

- [ ] Add real tests named `replaces published components without altering reported grades`, `preserves omitted grade collections and clears verified empty collections`, and `links only explicitly grouped same-log pitch attempts`. Retain current object reuse/history/cleanup/rollback/concurrent-cycle coverage using existing barriers and lock-wait evidence. Include same source IDs across owners/providers and Pitch numbers across different Climbs.

  ```ts
  expect(historicalLog.climb.publishedGrades).toEqual([{ value: "5.11a", system: "yds" }]);
  expect(historicalLog.reportedGrades).toEqual([{ value: "5.10d", system: "yds" }]);
  expect(historicalLog.climb.areaPath.map(a => a.name)).toEqual(["Updated region", "Updated crag"]);
  expect(afterOmittedMetadata).toMatchObject({ name: "Known climb", coordinates: { x: -122.25, y: 37.5 } });
  expect(remainingLogsAfterRejectedBatch).toEqual(logsBeforeBatch);
  expect(parentUpdates.filter(r => r.status === "rejected")).toHaveLength(1);
  ```

- [ ] Run `rtk pnpm test:unit src/db/source-attempt-facts.test.ts`, then `rtk pnpm test:integration src/db/climbing-log-sync.integration.test.ts src/db/climbing-log-session-sync.integration.test.ts`; expect revised qualifier/scope/grade failures.
- [ ] Adapt the transactional, owner/provider-locked writer to resolve Area/Climb/Pitch/owned grades and all incoming scoped occurrences before history evaluation. Preserve UUIDs and every supplied fact. Reconcile counts within target groups, removing only surplus rows with entirely unknown facts on an explicit correction. Grouping, notes, arrays and explicit false protect described rows, including a parent referenced by recorded pitch children. Unknown pitch identity never acquires actual target order. Whole history and other pitches never contaminate identified-pitch Flash history. Keep session aggregation/authoritative tombstoning separate from attempt facts.
- [ ] Run all three suites and affected provider units; expect PASS without optional transaction guards, module mocks in database tests, or capability casts.
- [ ] Review rollback, source identity, cycle serialization, and Flash self-exclusion; retain changes for the coordinated commit.

## Task 5: Move existing providers and imports to the common writer

Verified mapping references: theCrag's [tick definitions](https://www.thecrag.com/en/article/ticktypes)
and [grade systems](https://www.thecrag.com/en/article/gradesonthecrag), and
OpenBeta's [Climb/Pitch schema](https://github.com/OpenBeta/openbeta-graphql/blob/f1508b2479cc7658ac4341d59ec817836190d6d8/src/graphql/schema/Climb.gql)
and [tick semantics](https://github.com/OpenBeta/openbeta-graphql/blob/f1508b2479cc7658ac4341d59ec817836190d6d8/documentation/tick_logic.md).

**Files:** Existing adapter/client files in the map and their colocated tests; `mountain-project-sync.integration.test.ts`, `openbeta-sync.integration.test.ts`, `thecrag-sync.integration.test.ts`, `kaya/import.integration.test.ts`; create `src/providers/kaya-sync.integration.test.ts` using PostgreSQL and MSW.

**Interfaces:** Consume Task 4 source-input types and the entries/session
writers. Keep `sync(run: SyncRun): Promise<SyncResult>`. Occurrence keys remain
distinct from Climb/Pitch IDs; preserve verified provider uniqueness scopes.
KAYA session-scoped keys use immutable verified upstream session identity;
verify standalone ascent identity and session reassignment before changing
an existing key. Separate summary/send records remain separate raw occurrences
unless their upstream identity itself establishes one record.

- [ ] Add failing adapter tests for published versus reported grade ownership, equivalent/compound grade components, OpenBeta catalogue Pitch definitions without pitch tries, source-scoped method/solo/protection/history facts, and combined Fell/Hung without an invented completion outcome. Retain repeat IDs, count expansion, coordinate ownership, verified setting, partial discovery and complete-session tombstones. KAYA CSV permits missing grade/date/gym without fabricating an Activity.

  ```ts
  expect(repeatedClimbLogs).toHaveLength(2);
  expect(new Set(repeatedClimbLogs.map(l => l.climbId)).size).toBe(1); // Verified source object ID.
  expect(kayaSummaryAttempts).toHaveLength(4);
  expect(csvClimbsWithoutIds.map(c => c.externalId)).toEqual([null, null]);
  expect(unverifiedOutdoorClimb.setting).toBeNull();
  expect(gymPointOwner).toBe("area");
  expect(openBetaCataloguePitch.publishedGrades).toEqual([{ value: "5.12a", system: "yds" }]);
  expect(openBetaTickAttempts.map(a => a.scope)).toEqual(["climb"]);
  expect(fellHungAttempt).toMatchObject({ fellOrHung: true, outcome: null });
  expect(aidFlashAttempt).toMatchObject({ usedAid: true, fellOrHung: null });
  expect(greenpointAttempt.protectionUsed).toEqual(["trad"]);
  expect(greenpointClimb.routeProtection).toEqual(["sport"]);
  ```

- [ ] Run focused provider unit/client tests and `rtk pnpm test:integration src/providers/mountain-project-sync.integration.test.ts src/providers/openbeta-sync.integration.test.ts src/providers/thecrag-sync.integration.test.ts src/providers/kaya-sync.integration.test.ts src/providers/kaya/import.integration.test.ts`; expect old-contract/count/coordinate failures.
- [ ] Normalize each source independently into the approved grade/attempt input. Preserve Mountain Project/theCrag cursor and occurrence rules. Select verified OpenBeta Climb/Pitch IDs and grade collections; catalogue pitch count is not attempt evidence. Map theCrag AID/AIDC, WICE, AICE, MIXED, IFAS, NCCS, UK and UKT by their verified meanings; do not map NCCST to NCCS or infer Australian aid/mixed systems from M prefixes. Keep exact unverified pitch payloads and grade roles in provenance until verified. Separate Climb points from Area centers, and KAYA actual Climb IDs from compound attempted-record IDs. No provider-wide setting default or narrative fact extraction.
- [ ] Replace every direct old-table writer, preserve transaction boundaries for activity/session operations and authoritative list handling, and run the same provider suites; expect PASS.
- [ ] Review provider identity/mapping independently of generic persistence and retain changes for the coordinated commit. Unverified source fields stay null; do not request external refresh as part of this task.

## Task 6: Generic log projection, attachments, and deletion

**Files:** Contract/log repository/associator/router files in the map; relevant unit/integration tests and `activity-repository.integration.test.ts`.

**Interfaces:** Produce `ClimbingLogEntryDetail` from
`climbingLogEntryDetailSchema`: shared log fields and reported grades,
`climb: (Climb & { areaPath: Area[]; pitches: Pitch[] }) | null`, scoped
attempts with server-derived `rockResultLabels: Array<"sent" | "Onsight" |
"Flash" | "Pinkpoint">`, `recordedClimbAttemptCount: number`,
`recordedPitchAttemptCount: number`, `recordedClimbOutcome: AttemptOutcome | null`,
`pitchResults: ClimbingPitchResult[]`, `displayGrade: string | null`, and
existing sourceLinks. `ClimbingPitchResult` contains `pitch: Pitch | null`,
`attemptIds: string[]`, `recordedAttemptCount: number`,
`recordedOutcome: AttemptOutcome | null`, and `displayGrade: string | null`.
Group identified results only by the same Pitch; each unidentified pitch try
remains individually scoped without inventing shared identity. The full attempt
list retains parentAttemptId. All these counts/results/labels are derived
server values, never persisted columns or client calculations.

Rename repository method to
`ClimbingActivityLogEntryRepository.getActivityLogEntries(activityId: string):
Promise<ClimbingActivityLogEntry[]>`; wrapper `toDetail(): ClimbingLogEntryDetail`.
Router procedures become `activityLogEntries({ activityId })`,
`unattachedClimbingLogEntries({ activityId })`, and
`attachClimbingLogEntry({ climbingLogEntryId, activityId })`.
Associator methods remain `getSuggestions(activityId: string):
Promise<ClimbingLogEntrySuggestion[]>` and `attachLogEntry(input:
{ climbingLogEntryId: string; activityId: string }): Promise<void>`;
rename corresponding suggestion schema/cache keys.

- [ ] Write PostgreSQL tests named `projects a completed pitch without claiming route completion`, `counts one whole try and two pitch children separately`, `keeps unidentified pitch results visible`, and `preserves reported grades during published updates`. Retain unknown dates, recursive current path, same-user attachment gates, and transactional single/bulk soft-deletion tests. Assert labels on their actual attempts, including aid completion and a completed boulder dab.

  ```ts
  expect(genericSummit).toMatchObject({ climbedOn: null, recordedClimbAttemptCount: 1, recordedClimbOutcome: "completed" });
  expect(genericSummit.climb).toMatchObject({ publishedGrades: [] });
  expect(pitchOnlyLog).toMatchObject({ recordedClimbAttemptCount: 0, recordedPitchAttemptCount: 2, recordedClimbOutcome: null });
  expect(groupedLog).toMatchObject({ recordedClimbAttemptCount: 1, recordedPitchAttemptCount: 2 });
  expect(completedAid.rockResultLabels).toEqual([]);
  expect(afterAttach.climbedOn).toBe("2026-10-01");
  expect(afterSoftDelete).toMatchObject({ activityId: null, climbedOn: "2026-10-01" });
  expect(genericSummit.attempts[0].rockResultLabels).toEqual([]);
  ```

- [ ] Create `climbing-activity-log-entry-repository.integration.test.ts` and run `rtk pnpm test:integration packages/server/src/repositories/climbing-activity-log-entry-repository.integration.test.ts packages/server/src/repositories/climbing-log-entry-associator.integration.test.ts packages/server/src/repositories/activity-repository.integration.test.ts`; expect contract/association failures. Run `rtk pnpm test:unit packages/server/src/repositories/climbing-activity-log-entry-repository.test.ts packages/server/src/repositories/climbing-log-entry-associator.test.ts` to expose the changed contracts in existing tests.
- [ ] Implement recursive current-hierarchy projection and scoped aggregation. Whole outcome is completed when any whole attempt completed, failed only when at least one whole attempt exists and all explicitly failed, otherwise null. Apply the same rule only within each identified Pitch group; unidentified pitch outcomes retain individual scope. Return every grade component without join multiplication, coordinate conversion, independent attempt facts and fact-derived labels. Free sends require known absence of aid/falls/hangs and applicable dabs; aid qualifiers never become free-send labels. Sort known actual indices first with stable null/tie ordering, without storing inferred order. Preserve query-time repeat selection and source-origin checks. Unlink logs inside the Activity soft-delete transaction with same-user/type validation.
- [ ] Run projection/association/activity/router tests; expect PASS for both graded rock records and nullable generic logs.
- [ ] Review entity versus display ownership and deletion behavior; retain changes for the coordinated commit.

## Task 7: Rock analytics, training exposure, and MCP

**Files:** Rock analytics/mobile-training/MCP files in the map, shared climbing filters/context/grade/progression modules, `packages/format/src/climbing-context.ts` and `format.ts`, and their existing unit/integration suites.

**Interfaces:** Consume Task 6 scoped projections and Task 1 grade types.
Rename generic `climbType`/`ClimbingClimbType` to `climbKind`/`RockClimbKind`
in rock DTOs and helpers (`gradeSystemsForClimbKind`,
`isGradeSystemForClimbKind`); rock kind remains `boulder | route`.
Filters independently expose kind, discipline, attemptScope, ropeMethod, solo,
protectionUsed, advertised routeProtection, and nullable Climb setting.
Combined attempt filters must match the same attempt. Whole-result queries
use whole attempts and Climb published grades; explicit pitch-scope queries
use pitch attempts and their identified Pitch grades, without claiming route
completion. Select one conversion-supported component per eligible attempt:
prefer the user's supported source system, then source order among supported
components for the kind. Preserve all other grades for display. Do not convert
aid/ice/commitment grades or substitute log opinions for catalogue difficulty.

- [ ] Add tests named `counts one send despite equivalent and aid grade components`, `uses pitch grades only for pitch-scoped results`, `requires combined method and solo filters on the same attempt`, and `keeps aid completion and dabs out of free-send metrics`. Retain attached/standalone eligibility-before-conversion, known-rock ungraded participation, repeat selection, nullable date and verified-setting cases.

  ```ts
  expect(rockVolume.sends).toBe(1);
  expect(rockVolume.recordedAttempts).toBe(3);
  expect(progression.map(p => p.grade)).toEqual(["5.10a"]);
  expect(unknownSettingLog.climb.setting).toBeNull();
  expect(comparison.performances[0]?.metrics.climbing).toMatchObject({ attempts: 3, sends: 1 });
  expect(multiGradeVolume).toMatchObject({ sends: 1, recordedAttempts: 1 });
  expect(pitchScopedProgression[0].grade).toBe("5.12a");
  expect(wholeOnlyVolumeFromPitchLogs.recordedAttempts).toBe(0);
  expect(leadAndSoloMatches).toEqual([]); // Lead and solo evidence came from different attempts.
  expect(completedAidMetrics.sends).toBe(0);
  expect(completedDabMetrics.sends).toBe(0);
  ```

- [ ] Run `rtk pnpm test:integration packages/server/src/repositories/climbing-repository.integration.test.ts packages/server/src/repositories/climbing-progression-repository.integration.test.ts packages/server/src/repositories/performance-comparison-repository.integration.test.ts packages/server/src/repositories/analytical-training-load-repository.integration.test.ts` and affected shared/MCP unit tests; expect old names/eligibility failures.
- [ ] Select scope/target and one compatible published grade before aggregation in both query branches. Preserve one contribution per selected observation/attempt and existing query-time repeats. Use server-derived free-send facts, current setting and attempt-level filters; keep ungraded known-rock participation without converting unrelated grades. Update mobile-training validation and every MCP input/output consumer with the shared schema rather than duplicate client calculations.
- [ ] Run the same integration suites plus `mobile-dashboard.integration.test.ts`, shared training/format tests, and climbing/performance MCP tests; expect PASS. Assert the established pre-cutover rock fixture metrics remain equal apart from the explicitly approved setting change.
- [ ] Review scoped completion/free-send evidence, component selection and server metric ownership; retain changes for the coordinated commit.

## Task 8: Provider log records, full details, and counts

**Files:** Provider browse/count files in the map, provider-detail/sync router contracts, provider metadata tests, `provider-detail-repository.integration.test.ts`, `provider-stats-read-model.integration.test.ts`, and `sync-repository.integration.test.ts`.

**Interfaces:** Add `climbingLogEntries` to available-data-type/statistics contracts, with UI label `Climbing log`. Existing `providerDetail.records` returns server-curated concise columns; `providerDetail.recordDetail({ providerId, dataType: "climbingLogEntries", recordId })` returns full `ClimbingLogEntryDetail` and opaque provenance. Provider counts merge indexed PostgreSQL totals with existing statistics, including providers absent from ClickHouse results.
The list's `result` column is server-formatted scope-labelled text; a
pitch-only completed fixture displays `Pitch completed` and supplies no
whole-route completion label.

- [ ] Write tests named `counts logs independently of pitch attempt and grade joins` and `loads full owned pitch and grade details from a concise row`. Retain log-only provider counts without ClickHouse, stable undated ordering, current hierarchy/point and cross-user detail rejection.

  ```ts
  expect(sourceOnlyProviderStats.climbingLogEntries).toBe(3);
  expect(availableTypes).toContain("climbingLogEntries");
  expect(rows.map(r => r.id)).toEqual([newestDatedId, olderDatedId, undatedId]);
  expect(detail).toMatchObject({ notes: "Recorded source note", climb: { coordinates: { latitude: 37.5, longitude: -122.25 } } });
  expect(detail.sourceLinks).toHaveLength(2);
  expect(twoLogsWithManyGradesAndTries.climbingLogEntries).toBe(2);
  expect(pitchOnlyRow.result).toBe("Pitch completed");
  expect(detail.climb.pitches[0].publishedGrades).toHaveLength(2);
  expect(detail.reportedGrades).toHaveLength(1);
  ```

- [ ] Run the provider-detail/stats/sync integrations through `rtk pnpm test:integration` with the exact files above; expect missing type/count/detail failures.
- [ ] Implement the data type, Task 6 detail projection, concise scope-labelled list results, null-aware sort/filter logic, and indexed per-user/provider log counts independent of child joins. Merge counts through the existing statistics path, including providers absent from ClickHouse. Keep details out of list rows; no new analytics read model.
- [ ] Run affected repository/router/metadata tests; expect PASS with no sensor rows for the fixture provider.
- [ ] Review list/detail boundaries and scope enforcement; retain changes for the coordinated commit.

## Task 9: Web/mobile model and interaction parity

**Files:** Web `pages/ActivityDetailPage.tsx`, `pages/activity-detail/components/ClimbingLogEntry{Breakdown,Context,Sources}.tsx`, `UnattachedClimbingLogEntries.tsx`, `routes/training/climbing.tsx`, climbing charts/toggles, `pages/provider-detail-data.tsx`, `RecordDetailModal.tsx`, `ProviderDetailPage.tsx`, and ProviderStatsBreakdown. Mobile routes/components listed in the map, `ClimbingTrainingCard.tsx`, `ClimbingFilters.tsx`, provider detail modal/record formatting/statistics, and colocated or `app-tests/` tests/stories.

**Interfaces:** Both clients consume Tasks 6–8 responses without calculating
metrics. Selected-record modals call `providerDetail.recordDetail` for the
selected provider/data type/record ID. Generic record copy is `Climbing log`;
details render source date, current hierarchy/point, published and separately
reported grade collections, scoped attempts/results and their established
parent links, independent method/solo/aid/protection/history facts, notes and
source links. Use `Fell or hung` for the combined reported condition.

- [ ] Write matching web/mobile tests named `shows pitch completion with unknown whole-climb outcome`, `renders lead solo and aid independently`, `shows a completed dab without a send label`, and `renders published and reported grades separately`. Match scope/method/solo/protection filter requests and accessible labels. Retain nullable browsing, full detail fetch, cached refetch, actionable errors/source links and eligible hiking attachment cases.

  ```ts
  expect(screen.getByText("Climbing log")).toBeVisible();
  expect(recordDetailInput).toEqual({ providerId: "summitpost", dataType: "climbingLogEntries", recordId: selectedId });
  expect(screen.getByText("Recorded source note")).toBeVisible();
  expect(screen.getByText("Source date unknown")).toBeVisible();
  expect(screen.getByText(actionableServerMessage)).toBeVisible();
  expect(screen.getByText("Recorded summit")).toBeVisible(); // Assert before and during the pending background refetch.
  expect(screen.getByText("Pitch completed")).toBeVisible();
  expect(screen.getByText("Published grades")).toBeVisible();
  expect(screen.getByText("Reported grades")).toBeVisible();
  expect(filterInput).toMatchObject({ attemptScope: "pitch", ropeMethod: "lead", solo: true });
  ```

- [ ] Run `rtk pnpm test:unit packages/web/src/pages/ActivityDetailPage.test.tsx packages/web/src/pages/activity-detail/components/ClimbingLogEntryBreakdown.test.tsx packages/web/src/pages/activity-detail/components/UnattachedClimbingLogEntries.test.tsx packages/web/src/routes/training/climbing.test.tsx packages/web/src/pages/provider-detail-data.test.tsx packages/web/src/pages/RecordDetailModal.test.tsx` and `rtk pnpm test:mobile 'packages/mobile/app-tests/activity/[id].test.tsx' 'packages/mobile/app-tests/providers/[id].test.tsx' 'packages/mobile/app-tests/(tabs)/strain.test.tsx'`; expect old contract or missing detail behavior failures.
- [ ] Replace old interfaces/component names/imports and scalar-grade/clean fixtures. Render server summaries with scope labels, independent attempt facts and separate grade collections. Wire details and all filters, retain cached rows, and preserve attachment controls. Keep lists concise; parent grouping and notes belong in details. Shared formatting only formats already computed values. Update paired Storybook partial/unknown/error/refetch fixtures; mobile tests/helpers stay outside `app/`.
- [ ] Run matching web/mobile suites and typechecks; expect PASS. Visually inspect web and mobile stories with available browser/runtime tooling. For each HTTP development server, start `/Users/asherlc/bin/paseo-quick-tunnel <port>` for its entire lifetime and report only its emitted HTTPS trycloudflare URL.
- [ ] Review parity, screen-reader labels, and concise lists; retain changes for the coordinated commit.

## Task 10: Bounded conversion, lifecycle coverage, and complete cutover

**Files:** Create `src/db/climbing-log-model-conversion.ts`, `climbing-log-model-conversion.integration.test.ts`, `scripts/migrate-climbing-log-model.ts`, `scripts/migrate-climbing-log-model.test.ts`, `docs/climbing-log-model-cutover.md`; update migrations from Task 3 and lifecycle files/tests, including `src/db/account-erasure.integration.test.ts`. Create `src/export.integration.test.ts` and `src/account-erasure/postgres-erasure.integration.test.ts`. Retire `scripts/backfill-climbing-attempt-count.ts`, `src/db/climbing-attempt-count-backfill.ts`, its tests, and package command.

**Interfaces:** Produce `inspectClimbingLogConversion(db: Database): Promise<ClimbingLogConversionReport>`, `convertClimbingLogBatch(db: Database, batchSize: number): Promise<{ converted: number; remaining: number }>`, and `validateClimbingLogConversion(db: Database): Promise<ClimbingLogConversionReport>`. Report `{ inspected: number; conflicts: Array<{ climbingLogEntryIds: string[]; providerId: string; externalId: string | null; field: string; message: string }> }`. CLI subcommands are `inspect`, `prepare`, `convert`, `validate`, `finalize`; conversion accepts a positive `--batch-size` with default 100. Use existing DATABASE_URL handling; no new environment variable.

- [ ] Write populated PostgreSQL tests for verified published/reported grade ownership, independent attempt facts, Pitch definitions/results, legacy Fell/Hung with unknown completion, and ambiguous legacy clean=false rejection. Retain ID/provenance/date/coordinate preservation, unresolved shared-definition conflicts, bounded resumption, incomplete-finalization rejection and fresh-empty installation. Build faithful post-0145 fixtures; old per-log indices are not global order evidence.

  ```ts
  expect(convertedLog.id).toBe(legacyLogId);
  expect(convertedAttempt.id).toBe(legacyAttemptId);
  expect(convertedLog.climbedOn).toBe("2026-10-01");
  expect(unknownLegacyDate).toBeNull();
  expect(report.conflicts[0]).toMatchObject({ field: "publishedGrades", externalId: verifiedClimbId });
  expect(convertedFellHung).toMatchObject({ scope: "climb", fellOrHung: true, outcome: null });
  expect(ambiguousLegacyReport.conflicts[0].field).toBe("attemptFacts");
  expect(convertedLog.reportedGrades).toEqual([{ value: "5.10d", system: "yds" }]);
  expect(resumedResult.remaining).toBe(0);
  await expect(finalizeWithUnconvertedRows).rejects.toThrow("unconverted");
  ```

- [ ] Write real lifecycle tests including every Pitch and grade table: `exports the complete owned climbing graph`, `preserves shared published grades after deleting one log`, `deletes one providers graph without other-source activities`, `rejects late pitch and grade writes during account erasure`, and `covers and erases all climbing graph tables`. PostgreSQL graph writes use account-erasure fences; provider-generation fencing belongs to metric-stream/ClickHouse ingestion. Retain native point export and public-profile no-authorization evidence.

  ```ts
  expect(exportFiles).toEqual(expect.arrayContaining(["areas.csv", "climbs.csv", "pitches.csv", "climb-grades.csv", "pitch-grades.csv", "climbing-log-entry-grades.csv", "climbing-log-entries.csv", "climbing-attempts.csv"]));
  expect(exportedClimb.coordinates).toBe("(-122.25,37.5)");
  expect(otherProviderActivityAfterDeletion.id).toBe(otherProviderActivityId);
  await expect(assertPostgresAccountErasureCoverage(db)).resolves.toBeUndefined();
  await expect(lateWriteDuringErasure).rejects.toMatchObject({ cause: { code: "55000" } });
  ```

- [ ] Run `rtk pnpm test:integration src/db/climbing-log-model-conversion.integration.test.ts src/export.integration.test.ts src/db/provider-data-deletion.integration.test.ts src/account-erasure/postgres-erasure.integration.test.ts src/account-erasure/remote-snapshot.integration.test.ts` and `rtk pnpm test:unit scripts/migrate-climbing-log-model.test.ts`; expect missing conversion or lifecycle inventory failures.
- [ ] Implement inspection and bounded transactions with the existing temporary preparation marker. Inventory every legacy grade and execution fact; resolve published versus reported ownership and source meanings before conversion. Shared-definition conflicts require verified current metadata/source timestamps, never row creation precedence. Legacy clean=false is not a fall/hang fact; an unsent result is not necessarily objective failure. Fail preflight for known facts with no supported representation before dropping evidence. Preserve log/attempt UUIDs, source roles, scoped source outcomes, grouping and actual order only when established. Expand counts idempotently within target scope. Resumption selects unconverted rows; no persistent shadow store remains after finalization.
- [ ] Implement CLI migration sequencing using an operator-local temporary migration-directory prefix through preparation: copy exactly registered prefix SQL files, original prefix journal entries/timestamps, and complete `_history` so existing integrity checks hold. Call existing `runMigrations(databaseUrl, migrationsDir)` rather than modifying deploy's apply-all runner. `prepare` applies only that prefix; `convert` commits bounded batches; `validate` checks canonical coverage and contradictions; `finalize` validates and applies the full tracked directory. Detect already-finalized state before attempting an earlier prefix. Preserve legacy outcome/order columns separately during preparation until conversion establishes canonical nullable facts; drop them only at finalization. Finalization checks unconverted rows and essential target invariants, removes temporary markers/obsolete storage, and installs final constraints/projection. Inspect is read-only; operator commands require the documented quiesced window.
- [ ] Update all ownership joins, inventories, write fences and coverage for Area, Climb, Pitch, the three grade tables, log and scoped attempts. Export the eight filenames above using the existing hyphenated convention; serialize each native point once. Delete reported grades/attempts with their log while preserving shared published objects referenced by another retained log. Provider deletion follows dependency order and preserves other-source Activities. Erasure removes every owned row and fences late writes. Retire obsolete backfill code/commands completely.
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
  expect(ungradedLog.climb.publishedGrades).toEqual([]);
  expect(partialListRetainedLogIds).toEqual(previousLogIds);
  expect(syncResult.errors[0].message).toContain(failingSourceUrl);
  ```

- [ ] Run `rtk pnpm test:unit src/providers/summitpost.test.ts`; expect missing provider/parser failures.
- [ ] Implement the isolated adapter using verified selectors and Zod validation, `createProviderRateLimitFetch`, and existing pagination/error/telemetry contracts. Traverse all verified signed-log pages without climbed-date filtering, restrict profile identity and same-origin discovery links, and normalize only the connected author's logs. Store title/notes independently of Climb name, preserve verified grade components and attempt scope, and keep unknown facts null. No fabricated Activity or pitch try from catalogue metadata; missing/partial lists are not deletion evidence.
- [ ] Write and run `rtk pnpm test:integration src/providers/summitpost-sync.integration.test.ts` with PostgreSQL and MSW serving the verified fixture pack. Assert all manifest IDs/categories, page-two discovery, repeats, resync identity, unknown attempts, coordinates, response failures, and retention on interrupted discovery. First verify the failure, then fix only the diagnosed mapping/persistence defect until PASS.
- [ ] Register the working provider in every catalog/worker/server/queue/dataset/export location, document the public-profile connection on both clients, and run provider/auth/record UI suites plus full pre-push checks.
- [ ] Review source-contract evidence and complete fixture traversal, commit `feat: sync SummitPost climbing logs`, and push. State precisely whether the supplied live profile was reached and synced; request missing saved-page input if it still prevents that acceptance criterion.

## Task 12: Final acceptance and independent whole-branch review

**Files:** Update checklist/validation records in this plan and active docs only when the implementation evidence warrants it.

**Interfaces:** Modeling acceptance is one canonical model, all existing
providers/imports, generic records, preserved rock analytics, both clients,
full lifecycle and tested maintenance tooling. Review and ship that PR without
waiting for SummitPost browser access. Provider acceptance adds verified
SummitPost discovery/fixture traversal and a distinct provider change. Neither
approval authorizes executing the production maintenance cutover.

- [ ] Run the exact focused suites and full checks for Tasks 1–10 before shipping the modeling PR, and Task 11's provider suites before shipping the provider change. Repeat only after new changes/failures; record real outputs. Resolve the known paused-cutover TypeScript failures in old sync-helper/KAYA imports and adapter types through the canonical implementation, without compatibility aliases or suppressions.
- [ ] Request the selected Native workflow's fresh whole-branch review on the most capable available model for the deliverable being shipped. Include source semantics, grades/scope/filter join multiplication, migration evidence/rollback boundaries, hierarchy locks, target-scoped first-try/beta, lifecycle and paired clients. Fix substantive findings with failing-then-passing tests and rerun affected checks before committing/pushing corrections.
- [ ] Verify the permitted profile traversal against its discovery inventory if source access is available, including every verified signed-log page and category. Record imported occurrence count and unknown-field behavior; do not label fixture-only testing as a live successful sync.
- [ ] Commit/push remaining reviewed documentation or fixes after required checks, and provide implementation status, verified tests, any source-access/production-cutover boundary, and the concrete reviewed runbook. Close with a short retrospective and propose a field-ownership checklist in the schema/provider guide if it would prevent future duplicate storage; recommend the integration-tests-ready skill for the next schema/provider change.

## Plan self-review

Checked against every revised spec section: entities/enums/points (1, 3),
completed connection work (2), identity/hierarchy/grades/scoped reconciliation
and source mapping (4–5), independent dates/attachment/deletion and scoped
details (3, 6), generic records/counts and paired clients (8–9), free-rock
eligibility/component selection/filters/MCP (7), faithful conversion and every
owned lifecycle row/cleanup/doc (10), source-gated provider (11), and separate
modeling/provider acceptance (12). All five Review Focus cases have owning
executable tests. Native execution and the coordinated green commit remain;
no production action or successful live sync is implied by plan review.

Historical plan-only verification on 2026-10-13 passed full lint/root/package
types before the local cutover. At the revised-plan checkpoint, local root
compilation was not green; that historical result was not implementation
verification. The revised plan received
spelling/diff checks and root self-review only; no runtime tests are needed
for the documentation edits. Revised implementation steps were subsequently approved,
with the previously chosen Native execution method preserved.
