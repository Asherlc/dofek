# Processing Status Alert Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider sync failures actionable and non-duplicative by showing failure and last-success times, grouping one failed operation into one alert, and supporting durable account-wide dismissal on web and mobile.

**Architecture:** Keep processing events and operation history as the canonical source of truth. Add a relational dismissal record keyed by authenticated user and processing operation; have `ProcessingRepository` derive dismissal/failure timestamps and expose one grouped alert per current failed operation. Put grouping rules in `@dofek/providers` metadata so web and mobile render the same semantics, while each platform owns its mutation wiring and native presentation.

**Tech Stack:** PostgreSQL/Drizzle migrations, TypeScript, tRPC, React, React Native/Expo, `@dofek/providers`, Vitest, Testing Library, Docker-backed integration tests.

## Global Constraints

- Write tests first for every changed behavior; use real database integration tests when behavior depends on SQL, constraints, or migration semantics.
- Keep all metric/status values server-derived; clients only group/render the server-provided processing contract and must not infer timestamps from raw events.
- Maintain web/mobile parity for every status and alert behavior.
- Keep `packages/mobile/app/` route-only; put route tests under `packages/mobile/app-tests/`.
- Use a forward-only Postgres migration and update the Drizzle schema metadata through the repository's normal migration workflow.
- Do not modify provider adapters, sync workers, retry behavior, or raw processing events.
- Do not add dependencies or environment variables.
- Preserve the pre-existing untracked `.nx/plans/` worktree content; stage only files belonging to this feature.

## File map

- `src/db/schema/processing.ts`: Drizzle declaration for the dismissal relation.
- `drizzle/0071_processing_alert_dismissal.sql` and `drizzle/meta/*`: forward migration and generated schema metadata.
- `src/db/processing-alert-dismissals.integration.test.ts`: executable PostgreSQL coverage for the new relation's ownership and idempotency behavior.
- `packages/server/src/repositories/processing-repository.ts`: derive `lastFailedAt`/`errorMessage`, read dismissals, group current failures for alerts, and persist scoped dismissals.
- `packages/server/src/repositories/processing-repository.test.ts`: repository unit coverage for timestamps, grouping, dismissal state, ownership, and idempotency.
- `packages/server/src/routers/processing.ts`: validate the new response fields and expose `processing.dismiss`.
- `packages/server/src/routers/processing.test.ts`: tRPC contract, mutation, error, and cache invalidation coverage.
- `packages/providers-meta/src/processing-status.ts`: shared status grouping and failure presentation helpers that consume server-derived timestamps/messages.
- `packages/providers-meta/src/processing-status.test.ts`: shared grouping/resolution tests.
- `packages/providers-meta/src/processing-alerts.ts`: grouped alert contract and presentation data.
- `packages/providers-meta/src/processing-alerts.test.ts`: grouped-alert contract tests if new helpers are added there.
- `packages/web/src/components/ProcessingStatusWidget.tsx` and `.test.tsx`: provider/dashboard failure grouping, timestamps, dismissal control, and mutation errors.
- `packages/web/src/pages/AlertsPage.tsx` and `.test.tsx`: grouped alert cards and dismiss action.
- `packages/web/src/components/ProcessingStatusWidget.stories.tsx` and `packages/web/src/pages/AlertsPage.stories.tsx`: current grouped/dismissible failure fixtures.
- `packages/mobile/components/ProcessingStatusWidget.tsx` and `.test.tsx`: mobile-equivalent status behavior.
- `packages/mobile/app/alerts.tsx` and `packages/mobile/app-tests/alerts.test.tsx`: mobile alert dismissal behavior; route source remains under `app/`, tests remain outside it.
- Existing processing-status story fixtures and provider route fixtures under `packages/mobile/app-fixtures/`, `packages/mobile/app-stories/`, and `packages/mobile/app-tests/`: update response shapes with `lastFailedAt` and `dismissed` where TypeScript requires it.

---

### Task 1: Add the processing alert dismissal relation

**Files:**
- Create: `src/db/processing-alert-dismissals.integration.test.ts`
- Modify: `src/db/schema/processing.ts`
- Create: `drizzle/0071_processing_alert_dismissal.sql` through the normal migration generator
- Modify: `drizzle/meta/_journal.json` and the generated schema snapshot if the generator updates them

**Interfaces:**
- Produces the `processingAlertDismissal` Drizzle table and the database relation used by the repository in Task 2.
- Table columns: `userId: uuid`, `operationId: uuid`, `dismissedAt: timestamptz`.
- Constraints: primary key `(user_id, operation_id)`, foreign keys to `fitness.user_profile(id)` and `fitness.processing_operation(id)`, both `ON DELETE CASCADE`, and `dismissed_at DEFAULT now()`.

- [ ] **Step 1: Write the failing integration test**

Add a Docker-backed test that creates two fixture users and one processing operation for the first user, inserts a dismissal for that operation with a direct SQL helper, verifies the row can be read, verifies the table's duplicate primary key is enforced, and verifies a dismissal for the second user cannot reference the first user's operation through the foreign key relationship.

The database assertion must exercise the actual foreign keys rather than checking SQL text:

```ts
const insertDismissal = (userId: string, operationId: string) => database.execute(sql`
  INSERT INTO fitness.processing_alert_dismissal (user_id, operation_id)
  VALUES (${userId}::uuid, ${operationId}::uuid)
  RETURNING user_id, operation_id, dismissed_at
`);

await expect(insertDismissal(firstUserId, operationId)).resolves.toHaveLength(1);
await expect(insertDismissal(firstUserId, operationId)).rejects.toThrow();
await expect(insertDismissal(secondUserId, operationId)).rejects.toThrow();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration -- src/db/processing-alert-dismissals.integration.test.ts`

Expected: FAIL because the migration/table and schema declaration do not exist yet.

- [ ] **Step 3: Add the schema and migration**

Declare the table beside the other processing tables in `src/db/schema/processing.ts` and export it through the existing Drizzle schema aggregation if required. Generate the next forward migration with the repository's configured Drizzle workflow, keeping the SQL transaction-safe and free of data backfills:

```sql
CREATE TABLE fitness.processing_alert_dismissal (
  user_id uuid NOT NULL REFERENCES fitness.user_profile (id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES fitness.processing_operation (id) ON DELETE CASCADE,
  dismissed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT processing_alert_dismissal_pkey PRIMARY KEY (user_id, operation_id)
);
```

Update generated Drizzle metadata through the normal command, then run the migration policy check on the new SQL.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm test:integration -- src/db/processing-alert-dismissals.integration.test.ts`

Expected: PASS, including the real foreign-key and duplicate-key behavior.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema/processing.ts src/db/processing-alert-dismissals.integration.test.ts drizzle/0071_processing_alert_dismissal.sql drizzle/meta
git commit -m "feat: add processing alert dismissals"
```

---

### Task 2: Derive failure timestamps and durable dismissal state in the repository

**Files:**
- Modify: `packages/server/src/repositories/processing-repository.ts`
- Modify: `packages/server/src/repositories/processing-repository.test.ts`

**Interfaces:**
- `ProcessingStatusDataset` gains `lastFailedAt: string | null`.
- `ProcessingStatusOperation` gains `dismissed: boolean` and `errorMessage: string | null`, with the latter derived server-side from the most relevant failed event.
- `ProcessingRepository.dismiss(operationId: string): Promise<{ dismissed: true }>` inserts an idempotent dismissal only for an operation owned by `#userId`; an unknown or foreign operation throws a not-found error.
- `ProcessingRepository.status()` reads dismissal rows only for the scoped operations and returns dismissal state on each operation.
- `ProcessingRepository.alerts()` returns at most one grouped `ProcessingAlert` per current failed/blocked operation and excludes dismissed operations.

- [ ] **Step 1: Write failing repository tests**

Extend the existing fixtures and add tests for:

1. A failed event produces `lastFailedAt` from the event's `occurredAt`, not from `createdAt` or `lastAdvancedAt`.
2. A later ready operation leaves the dataset status ready and prevents the old failure from producing an alert.
3. Several failed datasets in one provider operation produce one alert whose `datasetKeys` contains all affected keys and whose `occurredAt` is the newest matching failure event.
4. A dismissal row marks the corresponding status operation as `dismissed: true` and removes it from `alerts()`.
5. `dismiss(operationId)` inserts once and succeeds again without duplicating the row.
6. `dismiss(operationId)` rejects an unknown or foreign operation with a specific not-found error.

Use a mocked event store as the current repository tests do, and mock only the database calls needed for dismissal lookup/insert. Assert the public repository result rather than private helpers:

```ts
expect(result.datasets[0]?.lastFailedAt).toBe("2026-07-22T16:00:00.000Z");
expect(result.operations[0]?.dismissed).toBe(true);
expect(alerts.alerts).toHaveLength(1);
expect(alerts.alerts[0]?.datasetKeys).toEqual(["activity", "recovery", "sleep"]);
```

- [ ] **Step 2: Run the focused repository tests to verify they fail**

Run: `pnpm test -- packages/server/src/repositories/processing-repository.test.ts`

Expected: FAIL because the result types and dismissal/grouping behavior are not implemented.

- [ ] **Step 3: Implement the smallest repository change**

Add typed row parsing for dismissal lookup. Load all dismissal operation IDs for the authenticated user and scoped operation IDs in one query. While mapping datasets, scan the already-loaded operation events for the newest failed event matching the dataset key (including operation-wide `datasetKey === null` failures) and serialize it as `lastFailedAt`. While mapping operations, derive one `errorMessage` from the most relevant failed event so clients never need to inspect the raw timeline to produce user-facing copy.

When mapping operations, attach `dismissed: dismissedOperationIds.has(operation.id)`. In `alerts()`, select current failed/blocked datasets, group them by their current operation ID, choose the newest matching failed event for `occurredAt`, combine the dataset keys/labels, use the existing action selection (`reconnect`, `retry_sync`, etc.), and omit dismissed groups.

Implement dismissal as an ownership-scoped insert/select. The query must not accept a provider or dataset label as identity:

```ts
INSERT INTO fitness.processing_alert_dismissal (user_id, operation_id)
SELECT ${this.#userId}::uuid, operation.id
FROM fitness.processing_operation operation
WHERE operation.id = ${operationId}::uuid
  AND operation.user_id = ${this.#userId}::uuid
ON CONFLICT (user_id, operation_id) DO NOTHING
RETURNING operation_id;
```

If no row is returned and the operation is not already dismissed for this user, throw the repository's specific not-found error. Keep unexpected database errors uncaught so the server telemetry/error boundary sees them.

- [ ] **Step 4: Run focused repository tests to verify they pass**

Run: `pnpm test -- packages/server/src/repositories/processing-repository.test.ts`

Expected: PASS, including all existing status/history/alert behavior and the new timestamp/grouping/dismissal cases.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/repositories/processing-repository.ts packages/server/src/repositories/processing-repository.test.ts
git commit -m "feat: derive processing failure timestamps"
```

---

### Task 3: Expose and invalidate the dismissal tRPC mutation

**Files:**
- Modify: `packages/server/src/routers/processing.ts`
- Modify: `packages/server/src/routers/processing.test.ts`

**Interfaces:**
- `processing.status` output includes `datasets[].lastFailedAt`, `operations[].dismissed`, and `operations[].errorMessage`.
- `processing.alerts` output accepts one grouped alert with `datasetKeys`/`datasetLabels` and the operation ID as its stable `id`.
- New mutation: `processing.dismiss.input({ operationId: z.uuid() })` returns `{ dismissed: true }`.

- [ ] **Step 1: Write failing router tests**

Add tests that:

- validate the new status/alert fields through the runtime output schema;
- call `processing.dismiss` with a valid UUID and assert the repository method receives it;
- assert the mutation invalidates `${userId}:processing.` after success;
- assert repository not-found errors reach the caller instead of being swallowed.

Use the existing mocked `ProcessingRepository` class and cache mock pattern. The success assertion should be explicit:

```ts
mockDismiss.mockResolvedValue({ dismissed: true });
await expect(caller.dismiss({ operationId })).resolves.toEqual({ dismissed: true });
expect(mockDismiss).toHaveBeenCalledWith(operationId);
expect(invalidateByPrefix).toHaveBeenCalledWith(`${userId}:processing.`);
```

- [ ] **Step 2: Run the router tests to verify they fail**

Run: `pnpm test -- packages/server/src/routers/processing.test.ts`

Expected: FAIL because the output schema and mutation do not exist.

- [ ] **Step 3: Implement the router contract and mutation**

Add the new nullable timestamp, boolean, and server-derived error fields to `statusOutputSchema`, update the grouped alert schema, import `queryCache`, and add:

```ts
dismiss: protectedProcedure
  .input(z.object({ operationId: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    const result = await new ProcessingRepository(ctx.db, ctx.userId).dismiss(input.operationId);
    await queryCache.invalidateByPrefix(`${ctx.userId}:processing.`);
    return result;
  }),
```

Do not add a broad cache invalidation or a client-only fallback.

- [ ] **Step 4: Run the router tests to verify they pass**

Run: `pnpm test -- packages/server/src/routers/processing.test.ts`

Expected: PASS, including existing alerts, history, data-quality, and runtime-schema tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routers/processing.ts packages/server/src/routers/processing.test.ts
git commit -m "feat: expose processing alert dismissal"
```

---

### Task 4: Add shared grouping and copy helpers

**Files:**
- Modify: `packages/providers-meta/src/processing-status.ts`
- Modify: `packages/providers-meta/src/processing-status.test.ts`
- Modify: `packages/providers-meta/src/processing-alerts.ts` and its test if the alert type/helper changes require it

**Interfaces:**
- Add `ProcessingFailureGroup` with `operationId`, `providerLabel`, `datasetLabels`, `status`, `failedAt`, `lastReadyAt`, `errorMessage`, and `dismissed`.
- Add `processingFailureGroups(input)` that consumes the structural status snapshot and returns only current, non-dismissed failed/blocked operation groups.
- Replace client use of `processingDatasetErrorMessage` with the operation's server-derived `errorMessage`; remove that helper and update its focused tests if it has no remaining production consumers.
- Change `ProcessingAlert` from one `datasetKey` to grouped `datasetKeys` and `datasetLabels`, with `id` equal to the operation ID.

- [ ] **Step 1: Write failing shared-helper tests**

Cover the exact user-visible rules:

```ts
const groups = processingFailureGroups({ datasets: failedDatasets, operations });
expect(groups).toEqual([
  expect.objectContaining({
    operationId: "operation-1",
    datasetLabels: ["Activities", "Recovery", "Sleep"],
    failedAt: "2026-07-22T16:00:00.000Z",
    lastReadyAt: "2026-07-21T12:00:00.000Z",
  }),
]);
```

Also assert that a dismissed operation yields no group, a later ready dataset yields no group, separate operation IDs remain separate, a missing `lastReadyAt` remains `null`, and the group uses `dataset.lastFailedAt`/`operation.errorMessage` without reading the timeline.

- [ ] **Step 2: Run the shared tests to verify they fail**

Run: `pnpm test -- packages/providers-meta/src/processing-status.test.ts packages/providers-meta/src/processing-alerts.test.ts`

Expected: FAIL because the group type/function and grouped alert contract are not implemented.

- [ ] **Step 3: Implement deterministic grouping and copy**

Group by the operation ID that contains each current failed/blocked dataset, sort dataset labels in the server-provided dataset order, and derive the group's failure timestamp from the newest `dataset.lastFailedAt`. Use the operation's server-derived `errorMessage` and `dismissed` flag. Do not read or transform raw server event payloads in clients. Return one group per operation.

Update the alert type and any helper that builds titles/messages so grouped provider sync alerts say what happened once and retain the existing action semantics. Keep strings concise and explicit about recovery:

```ts
title: `${providerLabel} sync didn’t finish`;
message: `Dofek couldn’t get the latest data from ${providerLabel}. Reconnect ${providerLabel}, then start the sync again.`;
```

- [ ] **Step 4: Run the shared tests to verify they pass**

Run: `pnpm test -- packages/providers-meta/src/processing-status.test.ts packages/providers-meta/src/processing-alerts.test.ts`

Expected: PASS with the pre-existing status presentation tests unchanged except for intentional grouped-contract updates.

- [ ] **Step 5: Commit**

```bash
git add packages/providers-meta/src/processing-status.ts packages/providers-meta/src/processing-status.test.ts packages/providers-meta/src/processing-alerts.ts packages/providers-meta/src/processing-alerts.test.ts
git commit -m "feat: group processing failure presentation"
```

---

### Task 5: Update the web status widget and alerts page

**Files:**
- Modify: `packages/web/src/components/ProcessingStatusWidget.tsx`
- Modify: `packages/web/src/components/ProcessingStatusWidget.test.tsx`
- Modify: `packages/web/src/components/ProcessingStatusWidget.stories.tsx`
- Modify: `packages/web/src/pages/AlertsPage.tsx`
- Modify: `packages/web/src/pages/AlertsPage.test.tsx`
- Modify: `packages/web/src/pages/AlertsPage.stories.tsx`

**Interfaces:**
- Web components consume the updated tRPC response shape and call `trpc.processing.dismiss.useMutation()` with `operationId`.
- `ProcessingStatusWidget` renders no failed card when all current failure groups are dismissed, including when `alwaysVisible` is true.
- The web alerts page renders grouped labels/timestamps and offers both the existing recovery action and a `Dismiss` action.

- [ ] **Step 1: Write failing web tests**

Update fixtures with `lastFailedAt` and operation `dismissed`. Add tests that render six failed Wahoo datasets and assert:

```tsx
expect(screen.getAllByText("Activities")).toHaveLength(1);
expect(screen.getByText("Failed: 16d ago")).toBeTruthy();
expect(screen.getByText("Last successful update: 16d ago")).toBeTruthy();
expect(screen.getByRole("button", { name: "Dismiss Wahoo sync failure" })).toBeTruthy();
```

Clicking the button must call the mocked mutation with the operation ID and invalidate/refetch the status query. Add cases for a dismissed group being absent, a later ready status being absent, a single error message, and mutation errors remaining visible. Update AlertsPage tests to assert one grouped card, dismiss action invocation, and server error rendering.

- [ ] **Step 2: Run the web tests to verify they fail**

Run: `pnpm test -- packages/web/src/components/ProcessingStatusWidget.test.tsx packages/web/src/pages/AlertsPage.test.tsx`

Expected: FAIL because the widgets still render dataset rows and do not expose dismiss mutations or grouped timestamps.

- [ ] **Step 3: Implement the web presentation**

Use `processingFailureGroups` for the widget. Render one grouped detail block per group with `formatRelativeTime(group.failedAt)` and the optional last-success line. Keep the current active/progress branch unchanged. Add a dismiss mutation with a pending-disabled button and an `onError` path that renders `error.message` in an alert region. Invalidate only the status query scope after success.

In `AlertsPage`, use the grouped `ProcessingAlert` contract, render `datasetLabels` once, and add a separate dismiss button that calls `processing.dismiss` with `alert.id`; invalidate `processing.alerts` on success. Preserve the retry/reconnect actions and existing error boundary behavior.

- [ ] **Step 4: Run the web tests to verify they pass**

Run: `pnpm test -- packages/web/src/components/ProcessingStatusWidget.test.tsx packages/web/src/pages/AlertsPage.test.tsx`

Expected: PASS, including existing loading/background-refetch/accessibility coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/ProcessingStatusWidget.tsx packages/web/src/components/ProcessingStatusWidget.test.tsx packages/web/src/components/ProcessingStatusWidget.stories.tsx packages/web/src/pages/AlertsPage.tsx packages/web/src/pages/AlertsPage.test.tsx packages/web/src/pages/AlertsPage.stories.tsx
git commit -m "feat: clarify web processing failures"
```

---

### Task 6: Update the mobile status widget and alerts screen

**Files:**
- Modify: `packages/mobile/components/ProcessingStatusWidget.tsx`
- Modify: `packages/mobile/components/ProcessingStatusWidget.test.tsx`
- Modify: `packages/mobile/components/ProcessingStatusWidget.stories.tsx`
- Modify: `packages/mobile/app/alerts.tsx`
- Modify: `packages/mobile/app-tests/alerts.test.tsx`
- Modify: mobile route/story fixtures that construct processing snapshots

**Interfaces:**
- Mobile uses the same `processingFailureGroups` rules and `processing.dismiss` mutation input as web.
- Mobile route tests remain in `packages/mobile/app-tests/`; no helper/test/story files are added under `packages/mobile/app/`.
- Buttons expose accessible labels: `Dismiss Wahoo sync failure` for status groups and `Dismiss`/provider-specific labels for alert cards.

- [ ] **Step 1: Write failing mobile tests**

Mirror the web fixtures and assert one grouped Wahoo failure, failure/last-success timestamps, one error, dismissed-group absence, later-ready absence, and mutation-error visibility. In `app-tests/alerts.test.tsx`, assert that pressing dismiss calls the mutation with the alert operation ID and that the list invalidates after success.

- [ ] **Step 2: Run the mobile tests to verify they fail**

Run: `pnpm test -- packages/mobile/components/ProcessingStatusWidget.test.tsx packages/mobile/app-tests/alerts.test.tsx`

Expected: FAIL because the mobile components still render one row per dataset and have no dismissal mutation.

- [ ] **Step 3: Implement the mobile presentation**

Apply the same shared grouping output as web, using `Text`, `View`, and `Pressable` styles already established by `SourceProcessingStatusCard`. Disable the dismiss control while pending, preserve native accessibility roles/live regions, and render server mutation errors with `accessibilityRole="alert"`. Update `alerts.tsx` to render grouped labels and a separate dismiss control without moving any route files.

- [ ] **Step 4: Run the mobile tests to verify they pass**

Run: `pnpm test -- packages/mobile/components/ProcessingStatusWidget.test.tsx packages/mobile/app-tests/alerts.test.tsx`

Expected: PASS, including existing progress/accessibility and route-hygiene expectations.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/components/ProcessingStatusWidget.tsx packages/mobile/components/ProcessingStatusWidget.test.tsx packages/mobile/components/ProcessingStatusWidget.stories.tsx packages/mobile/app/alerts.tsx packages/mobile/app-tests/alerts.test.tsx packages/mobile/app-fixtures packages/mobile/app-stories
git commit -m "feat: clarify mobile processing failures"
```

---

### Task 7: Update fixtures, integration coverage, and validate the full change

**Files:**
- Modify: all existing processing-status fixtures/stories/tests reported by TypeScript after the response contract changes, especially `packages/mobile/app-fixtures/(tabs)/processing-status-story-fixture.ts`, `packages/mobile/app-stories/(tabs)/processing-status-story-fixture.test.ts`, and provider route fixtures.
- Create: `packages/server/src/repositories/processing-repository.integration.test.ts` for real migration-backed status/alert coverage.
- Modify: `docs/production-incident-baseline.md` only if validation reveals a production incident or deploy/infrastructure issue; do not append an entry for ordinary local test failures.

**Interfaces:**
- Every fixture compiles against the final status/alert contract.
- Real database coverage verifies the migrated dismissal relation through the repository, not only through mocked SQL.

- [ ] **Step 1: Add/extend executable repository integration coverage**

Seed one user, a failed provider operation containing multiple datasets, a later successful operation, and a dismissal row. Assert:

```ts
expect((await repository.status({ providerId: "wahoo" })).datasets).toEqual(
  expect.arrayContaining([expect.objectContaining({ lastFailedAt: expect.any(String) })]),
);
await repository.dismiss(failedOperationId);
await expect(repository.alerts()).resolves.toEqual(expect.objectContaining({ alerts: [] }));
```

Then seed a later ready operation and assert the old failure is not current even if its history remains present.

- [ ] **Step 2: Run the integration suite to verify the new coverage passes**

Run: `pnpm test:integration -- packages/server/src/repositories/processing-repository.integration.test.ts`

Expected: PASS against the current Compose Postgres dependency, with no historical backfill replay.

- [ ] **Step 3: Run the focused unit suites together**

Run: `pnpm test -- packages/providers-meta/src/processing-status.test.ts packages/providers-meta/src/processing-alerts.test.ts packages/server/src/repositories/processing-repository.test.ts packages/server/src/routers/processing.test.ts packages/web/src/components/ProcessingStatusWidget.test.tsx packages/web/src/pages/AlertsPage.test.tsx packages/mobile/components/ProcessingStatusWidget.test.tsx packages/mobile/app-tests/alerts.test.tsx`

Expected: PASS.

- [ ] **Step 4: Run typecheck and lint**

Run: `pnpm typecheck`

Expected: PASS with no response-shape errors in web, mobile, server, stories, or fixtures.

Run: `pnpm lint`

Expected: PASS with no migration-policy, route-hygiene, or accessibility violations.

- [ ] **Step 5: Review the final diff and test for scope**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~7..HEAD
```

Confirm that `.nx/plans/` remains untracked and untouched, no provider/sync worker files changed, no duplicate failure rows remain in either platform, and all new server errors surface through existing error/telemetry paths.

## Execution handoff

After this plan is approved, execute it with `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Each task ends with its own focused test run and commit; stop at the review checkpoints if a test reveals a root-cause issue outside the approved design.
