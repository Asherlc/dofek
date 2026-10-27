# Read-Only Tracking Implementation Plan

> Execute this plan task by task and use the checkbox (`- [ ]`) steps to track progress. Agentic workers may use a repository-approved planning or delegation workflow, but the implementation requirements below stand on their own.

**Goal:** Make journal, life-event, and subjective body-state tracking read-only across web, mobile, and tRPC while preserving historical data, provider ingestion, and all read analytics.

**Architecture:** Remove mutation callers before pruning the corresponding tRPC procedures and repository write methods. Keep the existing query-backed components and refactor them to render stored data without create, update, or delete state. Preserve the database schema and seed active read-path integration tests directly through test fixtures instead of production mutation APIs.

**Tech Stack:** TypeScript, React, React Native/Expo, tRPC, Drizzle SQL, Vitest, Testing Library, Storybook.

## Global Constraints

- Existing database rows and schema must remain intact; do not add a migration or delete historical data.
- Provider-driven journal ingestion, including WHOOP journal data, must remain unchanged.
- Preserve `journal.questions`, `journal.entries`, `journal.trends`, `lifeEvents.list`, `lifeEvents.analyze`, `subjective.regions`, `subjective.checkIn`, `subjective.injuries`, and `subjective.timeline`.
- Remove `journal.create`, `journal.update`, `journal.delete`, `journal.createQuestion`, `lifeEvents.create`, `lifeEvents.update`, `lifeEvents.delete`, `subjective.saveCheckIn`, `subjective.createInjury`, `subjective.updateInjury`, and `subjective.deleteInjury`.
- Follow the removal-testing policy: do not add tests whose only assertion is that a removed procedure, component, or control is absent.
- Keep loading, empty, cached-data refresh error, terminal error, and retry behavior for every retained query.
- Do not add disabled endpoints, compatibility aliases, feature flags, fallback mutation paths, or replacement data-entry UI.
- Keep the untracked workspace file `paseo.json` out of every commit.
- Run commit and push steps only when explicit user approval or the active workflow authorizes those repository changes.

---

### Task 1: Make journal tracking read-only

**Files:**

- Modify: `packages/web/src/components/JournalPanel.tsx`
- Modify: `packages/web/src/components/JournalPanel.test.tsx`
- Modify: `packages/web/src/components/JournalPanel.stories.tsx`
- Modify: `packages/web/src/components/test-helpers/TimeRangeSelectorConsumers.tsx`
- Modify: `packages/mobile/app/tracking.tsx`
- Modify: `packages/mobile/app-tests/tracking.test.tsx`
- Delete: `packages/web/src/components/AddJournalEntryModal.tsx`
- Delete: `packages/web/src/components/AddJournalEntryModal.test.tsx`
- Delete: `packages/web/src/components/AddJournalEntryModal.stories.tsx`

**Interfaces:**

- Consumes: `trpc.journal.entries.useQuery`, `trpc.journal.trends.useQuery`, `TimeRangeSelector`, and `PaginationControls`.
- Produces: `JournalPanel(): JSX.Element`, with History/Trends review modes and no mutation dependency; mobile Journal Trends uses provider-sync language in its empty state.

- [ ] **Step 1: Add a failing active-behavior test for manual-source provenance**

Add a journal entry fixture with `source: { providerId: "dofek", label: "Dofek" }`, render the Log tab, and verify the retained row identifies its source:

```tsx
it("shows provider attribution for a stored manual entry", () => {
  mocks.entriesQuery.mockReturnValue({ data: [entry], error: null, isLoading: false });

  render(<JournalPanel />);

  expect(screen.getByText("Dofek")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify the current delete-only manual row fails the provenance assertion**

Run:

```bash
pnpm vitest run --project unit packages/web/src/components/JournalPanel.test.tsx
```

Expected: FAIL because manual Dofek entries currently render a Delete action instead of source attribution.

- [ ] **Step 3: Remove journal mutation UI and render every entry as read-only**

Remove `AddJournalEntryModal`, `locallyReportedErrorMeta`, `captureException`, `trpc.useUtils()`, `showModal`, and `trpc.journal.delete.useMutation`. Rename the internal `"log"` tab to `"history"` and its visible label from `Log` to `History`. Reduce the row interfaces to read-only values:

```tsx
<DayGroup key={date} date={date} entries={dayEntries} />

{catEntries.map((entry) => (
  <JournalEntryRow key={entry.id} entry={entry} />
))}

function JournalEntryRow({ entry }: { entry: JournalEntry }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2">
        <span className="text-sm text-foreground">{entry.display_name}</span>
        <AnswerDisplay entry={entry} />
      </div>
      <JournalSourceDetails source={entry.source} />
    </div>
  );
}
```

Retain the History/Trends tabs, technical source-details disclosure, range selector, pagination, and all query states. Delete the add-entry component files and remove their Storybook/test-helper references. Remove only mutation handlers from `JournalPanel.stories.tsx`.

- [ ] **Step 4: Remove obsolete mutation tests and run the retained journal suites**

Delete the delete-failure test and mutation mocks from `JournalPanel.test.tsx`; do not replace them with absence assertions. Keep entry error, cached refresh, pagination, trends, provenance, and range tests. In mobile, replace the empty-state copy and its test expectation with:

```tsx
message="Sync a numeric or Yes/No journal observation to start reviewing trends."
```

Run:

```bash
pnpm vitest run --project unit packages/web/src/components/JournalPanel.test.tsx packages/web/src/components/JournalPanel.time-range.test.tsx
pnpm vitest run --project mobile packages/mobile/app-tests/tracking.test.tsx
pnpm lint:web-stories
```

Expected: PASS.

- [ ] **Step 5: Commit and push the web journal slice when authorized**

```bash
git add packages/web/src/components/JournalPanel.tsx packages/web/src/components/JournalPanel.test.tsx packages/web/src/components/JournalPanel.stories.tsx packages/web/src/components/test-helpers/TimeRangeSelectorConsumers.tsx packages/web/src/components/AddJournalEntryModal.tsx packages/web/src/components/AddJournalEntryModal.test.tsx packages/web/src/components/AddJournalEntryModal.stories.tsx packages/mobile/app/tracking.tsx packages/mobile/app-tests/tracking.test.tsx
git commit -m "refactor(web): make journal tracking read only"
git push
```

- [ ] **Step 6: Record the Task 1 retrospective**

Record the outcome, investigation required, useful next-time context, and concrete documentation, guideline, or skill improvements. If the task involved a production, deployment, CI, or infrastructure incident, append the required evidence and disposition to `docs/production-incident-baseline.md`.

---

### Task 2: Make the web life-events panel read-only

**Files:**

- Modify: `packages/web/src/components/LifeEventsPanel.tsx`
- Modify: `packages/web/src/components/LifeEventsPanel.test.tsx`
- Modify: `packages/web/src/components/LifeEventsPanel.stories.tsx`

**Interfaces:**

- Consumes: `trpc.lifeEvents.list.useQuery` and `trpc.lifeEvents.analyze.useQuery`.
- Produces: `LifeEventsPanel(): JSX.Element`, with event selection, pagination, analysis windows, and no write dependency.

- [ ] **Step 1: Update tests around retained event review behavior**

Keep the active tests for initial and cached list errors, pagination, selected-event analysis, stale-analysis isolation, and unit formatting. Remove the tests and mocks dedicated to add-form layout, create failures, and delete failures. Do not add assertions that buttons are absent.

The retained selection test should exercise the public behavior:

```tsx
render(<LifeEventsPanel />);
fireEvent.click(screen.getByRole("button", { name: /Travel Week/ }));
expect(screen.getByText(/Before/)).toBeInTheDocument();
expect(screen.getByText(/After|During|Since/)).toBeInTheDocument();
```

- [ ] **Step 2: Remove life-event mutation state and the add form**

Delete `AddEventForm`, `CATEGORIES`, `formatDateYmd`, `locallyReportedErrorMeta`, `captureException`, `showForm`, `trpc.useUtils()`, and both mutations. Keep event pills as selection controls because they only choose a read query.

Call `EventAnalysis` with read-only props:

```tsx
<EventAnalysis
  event={event}
  analysis={eventAnalysisDataSchema.nullable().parse(analysis.data ?? null)}
  loading={analysis.isLoading && analysis.data === undefined}
  windowDays={windowDays}
  onWindowChange={setWindowDays}
/>
```

Remove `onDelete` and `deleting` from the `EventAnalysis` parameter list and props type, then delete the corresponding Delete button from its rendered header.

Remove the Add event and Delete event UI, but retain query error panels, retries, empty state, pagination, event selection, and analysis-window controls.

- [ ] **Step 3: Update stories and run focused validation**

Remove `lifeEvents.create` and `lifeEvents.delete` request handlers and form-specific story assumptions. Retain list and analysis handlers.

Run:

```bash
pnpm vitest run --project unit packages/web/src/components/LifeEventsPanel.test.tsx
pnpm lint:web-stories
```

Expected: PASS.

- [ ] **Step 4: Commit and push the web life-events slice when authorized**

```bash
git add packages/web/src/components/LifeEventsPanel.tsx packages/web/src/components/LifeEventsPanel.test.tsx packages/web/src/components/LifeEventsPanel.stories.tsx
git commit -m "refactor(web): make life events read only"
git push
```

- [ ] **Step 5: Record the Task 2 retrospective**

Record the outcome, investigation required, useful next-time context, and concrete documentation, guideline, or skill improvements. If the task involved a production, deployment, CI, or infrastructure incident, append the required evidence and disposition to `docs/production-incident-baseline.md`.

---

### Task 3: Convert body-state review to read-only and remove mobile entry UI

**Files:**

- Modify: `packages/web/src/components/SubjectiveTrackingPanel.tsx`
- Modify: `packages/web/src/components/SubjectiveTrackingPanel.test.tsx`
- Modify: `packages/web/src/components/SubjectiveTrackingPanel.stories.tsx`
- Modify: `packages/web/src/pages/TrackingPage.tsx`
- Modify: `packages/mobile/app/(tabs)/recovery.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/recovery.test.tsx`
- Modify: `packages/mobile/app-stories/(tabs)/recovery.stories.tsx`
- Delete: `packages/mobile/components/SubjectiveTrackingPanel.tsx`
- Delete: `packages/mobile/components/SubjectiveTrackingPanel.test.tsx`
- Delete: `packages/mobile/components/SubjectiveTrackingPanel.stories.tsx`

**Interfaces:**

- Consumes on web: `trpc.subjective.checkIn.useQuery`, `trpc.subjective.regions.useQuery`, and `trpc.subjective.injuries.useQuery`.
- Produces on web: `SubjectiveTrackingPanel(): JSX.Element`, a query-only body-state summary.
- Produces on mobile: Recovery without a subjective manual-entry panel; mobile `/tracking` remains unchanged.

- [ ] **Step 1: Replace mutation tests with a failing stored-data presentation test**

Delete tests dedicated to all-clear, symptom staging, saving, score clamping, injury creation, editable dates, and independent input pickers. Add one active-behavior test using the existing query mocks:

```tsx
it("renders stored symptoms and injuries with body-region labels", () => {
  mocks.checkInQuery.mockReturnValue({
    data: {
      logged: true,
      symptoms: [{ id: "symptom-1", body_region_id: "left_hand", kind: "soreness", score: 4 }],
    },
  });
  mocks.injuriesQuery.mockReturnValue({
    data: [
      {
        id: "injury-1",
        kind: "niggle",
        body_region_id: "left_hand",
        onset_date: "2026-08-01",
        resolved_date: null,
        severity: 2,
        description: "Morning tenderness",
      },
    ],
  });

  render(<SubjectiveTrackingPanel />);

  expect(screen.getByText(/Left hand.*soreness.*4\/10/)).toBeInTheDocument();
  expect(screen.getByText(/Left hand.*Morning tenderness.*2\/10/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and verify the current form-oriented presentation fails**

```bash
pnpm vitest run --project unit packages/web/src/components/SubjectiveTrackingPanel.test.tsx
```

Expected: FAIL because the current injury row does not include its body-region label and the component still centers mutation drafts.

- [ ] **Step 3: Refactor the web component into a query-only summary**

Remove mutation hooks, telemetry, cache utilities, all local draft state, type guards, `useEffect`, and `useRef`. Build a region-label map from the retained regions query and render stored records only:

```tsx
const regionLabels = new Map((regions.data ?? []).map((region) => [region.id, region.label]));
const labelFor = (bodyRegionId: string) => regionLabels.get(bodyRegionId) ?? bodyRegionId;

{checkIn.data?.symptoms.map((symptom) => (
  <li key={symptom.id}>
    {labelFor(symptom.body_region_id)} · {symptom.kind} · {symptom.score}/10
  </li>
))}

{injuries.data?.map((injury) => (
  <li key={injury.id}>
    {labelFor(injury.body_region_id)} · {injury.kind} · {injury.description} · {injury.severity == null ? "Severity not recorded" : `${injury.severity}/10`} · {injury.onset_date}
  </li>
))}
```

Retain explicit query states for the check-in, regions, and injuries. Keep the distinction between Not logged, Logged all clear, and a logged symptom list.

Update the tracking-page subtitles so they describe review rather than entry:

```tsx
<PageSection title="Life Events" subtitle="Review changes and their impact">
<PageSection title="Body State" subtitle="Review recorded soreness, stiffness, tenderness, and niggles">
```

- [ ] **Step 4: Remove the mobile subjective entry component from Recovery**

Delete the import and `<SubjectiveTrackingPanel />` call in `packages/mobile/app/(tabs)/recovery.tsx`. Remove only mocks or story setup that existed for that child from the Recovery test and story. Delete the now-unreferenced mobile component, test, and story files. Do not add a test asserting the panel is absent.

- [ ] **Step 5: Update stories and run web/mobile validation**

Make the web Subjective story handlers query-only. Run:

```bash
pnpm vitest run --project unit packages/web/src/components/SubjectiveTrackingPanel.test.tsx
pnpm vitest run --project mobile 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'
pnpm lint:web-stories
pnpm check:mobile-app-routes
```

Expected: PASS.

- [ ] **Step 6: Commit and push the body-state slice when authorized**

```bash
git add packages/web/src/components/SubjectiveTrackingPanel.tsx packages/web/src/components/SubjectiveTrackingPanel.test.tsx packages/web/src/components/SubjectiveTrackingPanel.stories.tsx packages/web/src/pages/TrackingPage.tsx 'packages/mobile/app/(tabs)/recovery.tsx' 'packages/mobile/app-tests/(tabs)/recovery.test.tsx' 'packages/mobile/app-stories/(tabs)/recovery.stories.tsx' packages/mobile/components/SubjectiveTrackingPanel.tsx packages/mobile/components/SubjectiveTrackingPanel.test.tsx packages/mobile/components/SubjectiveTrackingPanel.stories.tsx
git commit -m "refactor(tracking): make body state read only"
git push
```

- [ ] **Step 7: Record the Task 3 retrospective**

Record the outcome, investigation required, useful next-time context, and concrete documentation, guideline, or skill improvements. If the task involved a production, deployment, CI, or infrastructure incident, append the required evidence and disposition to `docs/production-incident-baseline.md`.

---

### Task 4: Remove life-event annotation creation from experiments

**Files:**

- Modify: `packages/web/src/pages/PersonalExperimentsPage.tsx`
- Modify: `packages/web/src/pages/PersonalExperimentsPage.test.tsx`
- Modify: `packages/web/src/pages/PersonalExperimentsPage.stories.tsx`
- Modify: `packages/mobile/app/experiments.tsx`
- Modify: `packages/mobile/app-tests/experiments.test.tsx`
- Modify: `packages/mobile/app-stories/experiments.stories.tsx`

**Interfaces:**

- Consumes: `trpc.personalExperiments.analysis.useQuery` and its existing `annotations` array.
- Produces: Web and mobile experiment evidence cards that display linked annotations without calling `trpc.lifeEvents.create`.

- [ ] **Step 1: Narrow experiment tests to retained annotations and personal-experiment check-ins**

In the existing evidence tests, retain the fixture's linked annotation and verify it renders:

```tsx
expect(screen.getByText("Travel")).toBeInTheDocument();
expect(screen.getByText(/Different time zone/)).toBeInTheDocument();
```

Keep the `personalExperiments.checkIn` interaction test. Remove annotation form submission, life-event mutation mocks, and life-event invalidation expectations. Do not assert that annotation inputs are absent.

- [ ] **Step 2: Remove annotation mutation state from web**

Delete `annotationLabel`, `annotationNotes`, `annotationMutation`, its error panel, and both annotation inputs/button. Keep the existing read rendering:

```tsx
<div className="space-y-2 rounded border border-border p-3">
  <h5 className="text-xs font-medium text-muted">Experiment annotations</h5>
  {result.annotations.map((annotation) => (
    <p key={annotation.id} className="text-xs text-dim">
      <span className="text-foreground">{annotation.label}</span> · {annotation.startedAt}
      {annotation.notes ? ` · ${annotation.notes}` : ""}
    </p>
  ))}
</div>
```

Do not change experiment creation, stopping, or personal-experiment daily check-ins; they use a different API domain.

- [ ] **Step 3: Remove annotation mutation state from mobile**

Delete the two annotation state values, `trpc.lifeEvents.create.useMutation`, both annotation `TextInput`s, Save annotation `Pressable`, and its error state. Keep `result.annotations.map(...)` and the personal-experiment check-in controls.

- [ ] **Step 4: Update stories and run paired client tests**

Remove life-event create handlers/mocks from both story files while preserving analysis fixtures with linked annotations.

```bash
pnpm vitest run --project unit packages/web/src/pages/PersonalExperimentsPage.test.tsx
pnpm vitest run --project mobile packages/mobile/app-tests/experiments.test.tsx
pnpm lint:web-stories
```

Expected: PASS.

- [ ] **Step 5: Commit and push the experiment annotation slice when authorized**

```bash
git add packages/web/src/pages/PersonalExperimentsPage.tsx packages/web/src/pages/PersonalExperimentsPage.test.tsx packages/web/src/pages/PersonalExperimentsPage.stories.tsx packages/mobile/app/experiments.tsx packages/mobile/app-tests/experiments.test.tsx packages/mobile/app-stories/experiments.stories.tsx
git commit -m "refactor(experiments): make annotations read only"
git push
```

- [ ] **Step 6: Record the Task 4 retrospective**

Record the outcome, investigation required, useful next-time context, and concrete documentation, guideline, or skill improvements. If the task involved a production, deployment, CI, or infrastructure incident, append the required evidence and disposition to `docs/production-incident-baseline.md`.

---

### Task 5: Remove manual-write tRPC procedures and repository methods

**Files:**

- Modify: `packages/server/src/routers/journal.ts`
- Modify: `packages/server/src/routers/journal.test.ts`
- Modify: `packages/server/src/repositories/journal-repository.ts`
- Modify: `packages/server/src/repositories/journal-repository.test.ts`
- Modify: `packages/server/src/routers/life-events.ts`
- Modify: `packages/server/src/routers/life-events.test.ts`
- Modify: `packages/server/src/routers/hiking-insights-life-events.test.ts`
- Modify: `packages/server/src/repositories/life-events-repository.ts`
- Modify: `packages/server/src/repositories/life-events-repository.test.ts`
- Modify: `packages/server/src/routers/subjective.ts`
- Modify: `packages/server/src/routers/subjective.test.ts`
- Modify: `packages/server/src/repositories/subjective-repository.ts`
- Modify: `packages/server/src/repositories/subjective-repository.test.ts`
- Modify: `packages/server/src/repositories/personal-experiments-repository.integration.test.ts`
- Modify: `packages/server/src/routers/router-logic.integration.test.ts`
- Modify: `packages/server/src/routers/router-data.integration.test.ts`
- Modify: `packages/server/src/routers/router.integration.test.ts`

**Interfaces:**

- Consumes: the existing Postgres schema and read-query repository contracts.
- Produces: query-only `journalRouter`, `lifeEventsRouter`, and `subjectiveRouter`; read-only repository classes with no manual-write methods.

- [ ] **Step 1: Remove mutation router tests and keep query contract tests**

Delete mutation test blocks from the three focused router tests and `hiking-insights-life-events.test.ts`. Keep journal question/entry/trend tests, life-event list/analyze tests, and subjective regions/check-in/injuries/timeline tests. Remove mutation-only cache and telemetry mocks after their last consumer disappears.

Run the focused tests before implementation:

```bash
pnpm vitest run --project unit packages/server/src/routers/journal.test.ts packages/server/src/routers/life-events.test.ts packages/server/src/routers/subjective.test.ts packages/server/src/routers/hiking-insights-life-events.test.ts
```

Expected: the retained tests still pass; this step deliberately follows the repository rule against testing the absence of removed API members.

- [ ] **Step 2: Reduce the routers to their read procedures**

Delete only the mutation properties from each existing `router({ ... })` object. The final public keys must be exactly:

```ts
// journalRouter
questions;
entries;
trends;

// lifeEventsRouter
list;
analyze;

// subjectiveRouter
regions;
checkIn;
injuries;
timeline;
```

Keep the current implementations of those query properties byte-for-byte except for formatting or imports. Remove `protectedProcedure`, cache invalidation, telemetry, validation helpers, and mutation input schemas after their mutation consumers are deleted.

- [ ] **Step 3: Delete write-only repository code**

From `JournalRepository`, remove `ensureDofekProvider`, `createEntry`, `updateEntry`, `deleteEntry`, and `createQuestion`, plus `DOFEK_PROVIDER_ID`, `journalEntryFullRowSchema`, `JournalEntryFullRow`, and the `ensurePushProvider` import.

From `LifeEventsRepository`, remove `create`, `update`, `delete`, `#assertPersonalExperimentOwned`, `CreateLifeEventInput`, `UpdateLifeEventInput`, `PersonalExperimentAssociationError`, `lifeEventFullRowSchema`, and `LifeEventFullRow`.

From `SubjectiveRepository`, remove `saveCheckIn`, `getInjury`, `createInjury`, `updateInjury`, `deleteInjury`, `SaveCheckInSymptom`, and write-only transaction typing. Keep `subjectiveKindSchema` and `injuryKindSchema` private unless a remaining production import requires them.

The read-only constructor can use:

```ts
type ReadDatabase = Pick<Database, "execute">;

export class SubjectiveRepository extends BaseRepository<ReadDatabase> {
  // regions, checkIn, injuries, and timeline only
}
```

Delete the corresponding repository mutation tests; retain list, trend, check-in, injury-list, and timeline tests.

- [ ] **Step 4: Replace mutation-based integration fixtures with direct SQL**

Delete the life-event CRUD and journal mutation-cache integration blocks because they test removed product behavior. Where a retained read/analyze test needs a record, seed and clean it directly through `testCtx.db.execute`:

```ts
const seeded = await testCtx.db.execute<{ id: string }>(sql`
  INSERT INTO fitness.life_events
    (user_id, label, started_at, ended_at, category, ongoing, notes)
  VALUES
    (${TEST_USER_ID}, ${label}, ${startedAt}::date, ${endedAt}::date, ${category}, ${ongoing}, ${notes})
  RETURNING id::text AS id
`);
const eventId = seeded[0]?.id;
if (!eventId) throw new Error("Life-event fixture insert returned no row");
```

The local Drizzle test database returns the row array directly, as shown above. Cleanup with an explicit, test-scoped SQL delete by `eventId`.

In `personal-experiments-repository.integration.test.ts`, insert the linked annotation directly with `personal_experiment_id = ${experiment.id}` and retain the assertion that deleting an experiment nulls the link without deleting the life event. Do not call a removed repository method from a fixture.

- [ ] **Step 5: Run focused unit and integration validation**

```bash
pnpm vitest run --project unit packages/server/src/routers/journal.test.ts packages/server/src/routers/life-events.test.ts packages/server/src/routers/subjective.test.ts packages/server/src/routers/hiking-insights-life-events.test.ts packages/server/src/repositories/journal-repository.test.ts packages/server/src/repositories/life-events-repository.test.ts packages/server/src/repositories/subjective-repository.test.ts
pnpm test:integration -- packages/server/src/repositories/personal-experiments-repository.integration.test.ts packages/server/src/routers/router-logic.integration.test.ts packages/server/src/routers/router-data.integration.test.ts packages/server/src/routers/router.integration.test.ts
```

Expected: PASS without calling any removed mutation API.

- [ ] **Step 6: Commit and push the server API slice when authorized**

```bash
git add packages/server/src/routers/journal.ts packages/server/src/routers/journal.test.ts packages/server/src/repositories/journal-repository.ts packages/server/src/repositories/journal-repository.test.ts packages/server/src/routers/life-events.ts packages/server/src/routers/life-events.test.ts packages/server/src/routers/hiking-insights-life-events.test.ts packages/server/src/repositories/life-events-repository.ts packages/server/src/repositories/life-events-repository.test.ts packages/server/src/routers/subjective.ts packages/server/src/routers/subjective.test.ts packages/server/src/repositories/subjective-repository.ts packages/server/src/repositories/subjective-repository.test.ts packages/server/src/repositories/personal-experiments-repository.integration.test.ts packages/server/src/routers/router-logic.integration.test.ts packages/server/src/routers/router-data.integration.test.ts packages/server/src/routers/router.integration.test.ts
git commit -m "refactor(api): remove manual tracking mutations"
git push
```

- [ ] **Step 7: Record the Task 5 retrospective**

Record the outcome, investigation required, useful next-time context, and concrete documentation, guideline, or skill improvements. If the task involved a production, deployment, CI, or infrastructure incident, append the required evidence and disposition to `docs/production-incident-baseline.md`.

---

### Task 6: Align documentation and run the completion gates

**Files:**

- Modify: `docs/personal-experiments.md`
- Verify: all files changed in Tasks 1–5

**Interfaces:**

- Consumes: the completed read-only client and server behavior.
- Produces: accurate current-state documentation and final verification evidence.

- [ ] **Step 1: Update personal-experiment documentation**

Replace the current-slice claim that users can link new life events with the read-only behavior, citing the approved internal design:

```markdown
5. Review existing canonical life events already linked to an experiment as annotations; annotation creation is read-only in the current clients and API ([read-only tracking design](./superpowers/specs/2026-08-14-read-only-tracking-design.md)).
```

Do not change schema documentation because the schema and historical rows remain supported.

- [ ] **Step 2: Verify no production mutation caller or procedure remains**

```bash
rg -n 'journal\.(createQuestion|create|update|delete)|lifeEvents\.(create|update|delete)|subjective\.(saveCheckIn|createInjury|updateInjury|deleteInjury)' packages/web packages/mobile packages/server/src src --glob '!**/*.test.*' --glob '!**/*.stories.*'
```

Expected: no matches. Provider ingestion paths use separate functions and remain present.

- [ ] **Step 3: Run formatting, lint, type, dead-code, and test gates**

```bash
pnpm lint:fix
pnpm lint
pnpm typecheck
pnpm knip
pnpm test
pnpm test:integration
```

Expected: every command exits 0. If formatting changes files, rerun the focused tests for those files before committing.

- [ ] **Step 4: Review the final diff and confirm data/schema stability**

```bash
git diff --check
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD -- drizzle src/db/schema
git status --short
```

Expected: no whitespace errors; no migration or schema file changes; only `paseo.json` remains untracked outside the implementation diff.

- [ ] **Step 5: Commit and push documentation or formatting changes when authorized**

```bash
git add docs/personal-experiments.md
git add -u -- packages/web/src/components/JournalPanel.tsx packages/web/src/components/JournalPanel.test.tsx packages/web/src/components/JournalPanel.stories.tsx packages/web/src/components/test-helpers/TimeRangeSelectorConsumers.tsx packages/web/src/components/AddJournalEntryModal.tsx packages/web/src/components/AddJournalEntryModal.test.tsx packages/web/src/components/AddJournalEntryModal.stories.tsx packages/web/src/components/LifeEventsPanel.tsx packages/web/src/components/LifeEventsPanel.test.tsx packages/web/src/components/LifeEventsPanel.stories.tsx packages/web/src/components/SubjectiveTrackingPanel.tsx packages/web/src/components/SubjectiveTrackingPanel.test.tsx packages/web/src/components/SubjectiveTrackingPanel.stories.tsx packages/web/src/pages/TrackingPage.tsx packages/web/src/pages/PersonalExperimentsPage.tsx packages/web/src/pages/PersonalExperimentsPage.test.tsx packages/web/src/pages/PersonalExperimentsPage.stories.tsx packages/mobile/app/tracking.tsx packages/mobile/app-tests/tracking.test.tsx 'packages/mobile/app/(tabs)/recovery.tsx' 'packages/mobile/app-tests/(tabs)/recovery.test.tsx' 'packages/mobile/app-stories/(tabs)/recovery.stories.tsx' packages/mobile/components/SubjectiveTrackingPanel.tsx packages/mobile/components/SubjectiveTrackingPanel.test.tsx packages/mobile/components/SubjectiveTrackingPanel.stories.tsx packages/mobile/app/experiments.tsx packages/mobile/app-tests/experiments.test.tsx packages/mobile/app-stories/experiments.stories.tsx packages/server/src/routers/journal.ts packages/server/src/routers/journal.test.ts packages/server/src/repositories/journal-repository.ts packages/server/src/repositories/journal-repository.test.ts packages/server/src/routers/life-events.ts packages/server/src/routers/life-events.test.ts packages/server/src/routers/hiking-insights-life-events.test.ts packages/server/src/repositories/life-events-repository.ts packages/server/src/repositories/life-events-repository.test.ts packages/server/src/routers/subjective.ts packages/server/src/routers/subjective.test.ts packages/server/src/repositories/subjective-repository.ts packages/server/src/repositories/subjective-repository.test.ts packages/server/src/repositories/personal-experiments-repository.integration.test.ts packages/server/src/routers/router-logic.integration.test.ts packages/server/src/routers/router-data.integration.test.ts packages/server/src/routers/router.integration.test.ts
git commit -m "docs: describe read-only tracking inputs"
git push
```

If `git status --short` shows no tracked changes after validation, skip the empty commit and report the already-pushed implementation commits.

- [ ] **Step 6: Record the end-of-task retrospective**

In the final handoff, report:

- What went well: query/write boundaries made the deletion scope explicit.
- What required investigation: shared life-event annotation callers and integration fixtures that created records through production mutations.
- Useful next-time context: manual-write tRPC procedures may have UI callers outside `/tracking`.
- Proposed guideline improvement: add a repository map documenting which provider ingestion paths bypass user-facing tRPC mutations.
- Suggested skills: `superpowers:verification-before-completion` and `write-tests` for a similar cross-platform API removal.
