# Read-Only Supplements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supplement stack and dose history read-only on web and mobile, and remove the matching manual-write tRPC procedures and repository code.

**Architecture:** Preserve the existing `supplements.list` and `supplements.occurrences` projections and simplify both clients into query-and-render consumers. Remove `supplements.save` and `supplements.recordDose` at the router boundary, then delete their unreferenced persistence code while keeping provider sync, automatic occurrence generation, schema, analytics, and historical data unchanged.

**Tech Stack:** TypeScript, React, React Native, tRPC, Drizzle ORM, Vitest, Storybook, Biome.

## Global Constraints

- Implement web and mobile parity in the same branch.
- Keep the supplements routes, read queries, safety context, provider sync, database schema, analytics, and historical records.
- Keep pull-to-refresh and FDA/NIH source links because they do not modify health data.
- Remove add, edit, delete, reorder, save, `Taken`, and `Skip` entry points without deprecated endpoints, disabled controls, aliases, or compatibility layers.
- Do not add tests whose only purpose is to assert that a removed control or API procedure is absent.
- Preserve initial loading/error/empty states and cached data during background refresh errors.
- Do not add dependencies, migrations, environment variables, or provider behavior.
- Leave the unrelated untracked `paseo.json` untouched.

## File Map

- `packages/web/src/routes/nutrition/supplements.tsx`: read-only section copy.
- `packages/web/src/components/SupplementStackPanel.tsx`: web stack query and display only.
- `packages/web/src/components/SupplementStackPanel.test.tsx`: positive stack/query-state coverage.
- `packages/web/src/components/SupplementStackPanel.stories.tsx`: default/loading/empty read-only stories.
- `packages/web/src/components/SupplementDoseEventsPanel.tsx`: web occurrence history display only.
- `packages/web/src/components/SupplementDoseEventsPanel.test.tsx`: positive history/query-state coverage.
- `packages/web/src/components/SupplementDoseEventsPanel.stories.tsx`: query-only occurrence fixtures.
- `packages/mobile/app/supplements.tsx`: mobile stack, safety context, and dose history display only.
- `packages/mobile/app-tests/supplements.test.tsx`: positive route rendering/query-state coverage.
- `packages/mobile/components/SupplementDoseEventsPanel.tsx`: mobile occurrence history display only.
- `packages/mobile/components/SupplementDoseEventsPanel.test.tsx`: positive history/query-state coverage.
- `packages/mobile/components/SupplementDoseEventsPanel.stories.tsx`: query-only occurrence fixtures.
- `packages/server/src/routers/supplements.ts`: protected read procedures only.
- `packages/server/src/routers/supplements.test.ts`: list and occurrence procedure coverage only.
- `packages/server/src/routers/supplements-sync.test.ts`: retain list/projection coverage; delete replacement coverage.
- `packages/server/src/routers/router-data.integration.test.ts`: retain the list smoke test; delete the save round trip.
- `packages/server/src/repositories/supplements-repository.ts`: list and occurrence persistence only.
- `packages/server/src/repositories/supplements-repository.test.ts`: list, projection mapping, and occurrence coverage only.
- `packages/server/src/repositories/supplement-dose-events.integration.test.ts`: retain executable read/constraint/analytics tests with direct final-schema fixtures.
- `packages/server/src/repositories/test-helpers.ts`: shared direct supplement-definition fixture for retained integration tests.

---

### Task 1: Make the web supplement stack read-only

**Files:**
- Modify: `packages/web/src/routes/nutrition/supplements.tsx`
- Modify: `packages/web/src/components/SupplementStackPanel.tsx`
- Modify: `packages/web/src/components/SupplementStackPanel.test.tsx`
- Modify: `packages/web/src/components/SupplementStackPanel.stories.tsx`

**Interfaces:**
- Consumes: `trpc.supplements.list.useQuery(): Supplement[]`.
- Produces: `SupplementStackPanel(): JSX.Element`, with no mutation dependency or callback props.

- [ ] **Step 1: Change the empty-state test before production code**

In `SupplementStackPanel.test.tsx`, remove mutation mocks and mutation-only tests. Keep the loading and cached-refresh tests, and make the empty-state expectation describe provider-sourced data:

```tsx
it("uses the shared query state panel for an empty synced stack", () => {
  mocks.query.data = [];

  render(<SupplementStackPanel />);

  expect(screen.getByTestId("query-state-empty")).toBeDefined();
  expect(screen.getByText("No synced supplements available.")).toBeDefined();
});
```

Keep a positive cached-data assertion without testing removed controls:

```tsx
it("preserves cached supplements during a background refresh failure", () => {
  mocks.query.error = new Error("Supplement refresh failed.");

  render(<SupplementStackPanel />);

  expect(screen.getByText("Creatine")).toBeDefined();
  expect(screen.getByText("Supplement refresh failed.")).toBeDefined();
});
```

- [ ] **Step 2: Run the focused test and verify the new copy fails**

Run:

```bash
rtk pnpm vitest run --project unit packages/web/src/components/SupplementStackPanel.test.tsx
```

Expected: FAIL because the component still renders the old "No supplements configured" message.

- [ ] **Step 3: Simplify `SupplementStackPanel` to query and render**

Remove `useRef`, `useState`, mutation/cache/telemetry imports, `MEALS`, `UNITS`, `FORMS`, all form handlers, reorder state, `SupplementForm`, and every button. Keep `Supplement`, `NUTRIENT_FIELDS`, and `formatDose` for rendering. The component body becomes:

```tsx
export function SupplementStackPanel() {
  const stack = trpc.supplements.list.useQuery();
  const supplements: Supplement[] = stack.data ?? [];
  const hasCanonicalStack = stack.data !== undefined;

  if (stack.isLoading && !hasCanonicalStack) {
    return <QueryStatePanel variant="loading" height={80} />;
  }
  if (stack.error && !hasCanonicalStack) {
    return <QueryStatePanel error={stack.error} height={120} />;
  }

  return (
    <div className="space-y-3">
      {stack.error ? <QueryStatePanel error={stack.error} height={72} /> : null}
      {supplements.length === 0 ? (
        <QueryStatePanel
          variant="empty"
          message="No synced supplements available."
          height={72}
        />
      ) : null}
      {supplements.map((supp) => (
        <SupplementRow
          key={`${supp.name}-${supp.amount ?? ""}-${supp.unit ?? ""}-${supp.form ?? ""}-${supp.meal ?? ""}`}
          supp={supp}
        />
      ))}
    </div>
  );
}
```

Change `SupplementRow` to accept only `{ supp: Supplement }` and render the existing name, dose, meal, and nutrient content in a plain card with no reorder or edit controls.

- [ ] **Step 4: Update read-only page copy and stories**

In `supplements.tsx`, use:

```tsx
subtitle="Synced supplement definitions and nutrient details"
```

In `SupplementStackPanel.stories.tsx`, remove `saving` from `SupplementScenario`, remove the `supplements.save` mock branch, delete the `Saving` story, and remove the unused `expect` and `within` imports. Retain `Default`, `Loading`, and `Empty`.

- [ ] **Step 5: Run focused web tests and lint the changed files**

Run:

```bash
rtk pnpm vitest run --project unit packages/web/src/components/SupplementStackPanel.test.tsx packages/web/src/routes/nutrition/supplements.test.tsx
rtk pnpm biome check packages/web/src/routes/nutrition/supplements.tsx packages/web/src/components/SupplementStackPanel.tsx packages/web/src/components/SupplementStackPanel.test.tsx packages/web/src/components/SupplementStackPanel.stories.tsx
```

Expected: all tests and checks PASS.

- [ ] **Step 6: Commit and push**

```bash
rtk git add packages/web/src/routes/nutrition/supplements.tsx packages/web/src/components/SupplementStackPanel.tsx packages/web/src/components/SupplementStackPanel.test.tsx packages/web/src/components/SupplementStackPanel.stories.tsx
rtk git commit -m "refactor(web): make supplement stack read-only"
rtk git push
```

### Task 2: Make web dose history read-only

**Files:**
- Modify: `packages/web/src/routes/nutrition/supplements.tsx`
- Modify: `packages/web/src/components/SupplementDoseEventsPanel.tsx`
- Modify: `packages/web/src/components/SupplementDoseEventsPanel.test.tsx`
- Modify: `packages/web/src/components/SupplementDoseEventsPanel.stories.tsx`

**Interfaces:**
- Consumes: `trpc.supplements.occurrences.useQuery({ days: 7 })`.
- Produces: current status, counts, provenance, and history with no write callback.

- [ ] **Step 1: Reduce tests to positive read behavior**

Delete mutation fixtures and tests for recording, telemetry, and invalidation. Keep the existing test named `renders current status, history provenance, and counts without an adherence rate`, the cached-refresh test, and the four status cases. Do not add a negative test for missing buttons.

- [ ] **Step 2: Remove the mutation from the panel**

Remove `locallyReportedErrorMeta`, `captureException`, `trpc.useUtils()`, and `trpc.supplements.recordDose.useMutation()`. Render rows as:

```tsx
{occurrences.map((occurrence) => (
  <OccurrenceRow
    key={`${occurrence.scheduleId}:${occurrence.scheduledDate}`}
    occurrence={occurrence}
  />
))}
```

Change `OccurrenceRow` to accept only `occurrence`, delete its action container and buttons, and preserve the supplement name, scheduled date, formatted status, event count, source, and recorded time.

- [ ] **Step 3: Update the route copy and story transport**

Set the Recent Doses subtitle to:

```tsx
subtitle="Provider-recorded planned, taken, skipped, and unknown dose-event history"
```

In `SupplementDoseEventsPanel.stories.tsx`, make the mock return occurrence data only for `supplements.occurrences`; remove the fallback manual-record result `{ id: "new-event", status: "taken" }`.

- [ ] **Step 4: Run focused tests and lint**

```bash
rtk pnpm vitest run --project unit packages/web/src/components/SupplementDoseEventsPanel.test.tsx packages/web/src/routes/nutrition/supplements.test.tsx
rtk pnpm biome check packages/web/src/routes/nutrition/supplements.tsx packages/web/src/components/SupplementDoseEventsPanel.tsx packages/web/src/components/SupplementDoseEventsPanel.test.tsx packages/web/src/components/SupplementDoseEventsPanel.stories.tsx
```

Expected: PASS with no mutation references in the changed web files.

- [ ] **Step 5: Commit and push**

```bash
rtk git add packages/web/src/routes/nutrition/supplements.tsx packages/web/src/components/SupplementDoseEventsPanel.tsx packages/web/src/components/SupplementDoseEventsPanel.test.tsx packages/web/src/components/SupplementDoseEventsPanel.stories.tsx
rtk git commit -m "refactor(web): make supplement history read-only"
rtk git push
```

### Task 3: Make the mobile supplements screen read-only

**Files:**
- Modify: `packages/mobile/app/supplements.tsx`
- Modify: `packages/mobile/app-tests/supplements.test.tsx`

**Interfaces:**
- Consumes: `trpc.supplements.list.useQuery()` and `trpc.nutritionAnalytics.micronutrientAdequacyV2.useQuery({ days: 30 })`.
- Produces: a refreshable read-only screen with stack, safety context, and dose history.

- [ ] **Step 1: Change the empty-state test before production code**

Remove save/mutation mocks and mutation-only tests. Add this positive empty-state test:

```tsx
it("describes an empty synced supplement stack", async () => {
  mocks.query.data = [];
  const { default: SupplementsScreen } = await import("../app/supplements");

  render(<SupplementsScreen />);

  expect(screen.getByText("No synced supplements available.")).toBeTruthy();
});
```

Keep cached-refresh and server-owned safety-context coverage.

- [ ] **Step 2: Run the mobile route test and verify the new copy fails**

```bash
rtk pnpm vitest run --project mobile packages/mobile/app-tests/supplements.test.tsx
```

Expected: FAIL because the old manual-entry empty message remains.

- [ ] **Step 3: Remove all stack editing state and controls**

Delete `MealType`, `useRef`, `useState`, `AccessibilityInfo`, `Alert`, `Platform`, `TextInput`, `UNITS`, `FORMS`, `ChipPicker`, `AddSupplementForm`, `saveMutation`, and the add/delete/reorder handlers and styles. Keep `MEAL_OPTIONS` for displaying the configured meal.

Render the heading and stack without controls:

```tsx
<View style={styles.sectionHeader}>
  <Text style={styles.sectionTitle}>Supplements</Text>
</View>

{supplements.length === 0 && !stack.isLoading && !stack.error ? (
  <Text style={styles.emptyText}>No synced supplements available.</Text>
) : null}

{supplements.map((supp) => {
  const dose = formatDose(supp);
  const mealLabel = MEAL_OPTIONS.find((meal) => meal.value === supp.meal)?.label;
  return (
    <View key={supp.name} style={styles.card}>
      <View style={styles.cardContent}>
        <Text style={styles.cardLabel}>{supp.name}</Text>
        {dose ? <Text style={styles.cardSub}>{dose}</Text> : null}
        {mealLabel ? <Text style={styles.cardMeal}>{mealLabel}</Text> : null}
      </View>
    </View>
  );
})}
```

Preserve initial loading, initial error, cached-refresh error, pull-to-refresh, safety cards, `Linking.openURL`, and `captureException` for failed source-link navigation.

- [ ] **Step 4: Update the dose-section copy**

Use:

```tsx
<Text style={styles.sectionSubtitle}>
  Provider-recorded planned, taken, skipped, and unknown dose-event history.
</Text>
```

- [ ] **Step 5: Run focused mobile tests and lint**

```bash
rtk pnpm vitest run --project mobile packages/mobile/app-tests/supplements.test.tsx
rtk pnpm biome check packages/mobile/app/supplements.tsx packages/mobile/app-tests/supplements.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
rtk git add packages/mobile/app/supplements.tsx packages/mobile/app-tests/supplements.test.tsx
rtk git commit -m "refactor(mobile): make supplement stack read-only"
rtk git push
```

### Task 4: Make mobile dose history read-only

**Files:**
- Modify: `packages/mobile/components/SupplementDoseEventsPanel.tsx`
- Modify: `packages/mobile/components/SupplementDoseEventsPanel.test.tsx`
- Modify: `packages/mobile/components/SupplementDoseEventsPanel.stories.tsx`

**Interfaces:**
- Consumes: `trpc.supplements.occurrences.useQuery({ days: 7 })`.
- Produces: React Native status, count, provenance, and history views without action callbacks.

- [ ] **Step 1: Reduce tests to positive read behavior**

Rename the first test to `renders status, history provenance, and counts`, retain its status/history assertions, and delete its click/mutation assertion. Delete mutation telemetry and invalidation tests. Keep cached-refresh and all status cases. Do not add an assertion that buttons are absent.

- [ ] **Step 2: Remove record-dose behavior and action components**

Remove `TouchableOpacity`, `captureException`, `trpc.useUtils()`, the `recordDose` mutation, `disabled`/`onRecord` row props, `DoseButton`, and action-related styles. Render each occurrence using only:

```tsx
<OccurrenceRow
  key={`${occurrence.scheduleId}:${occurrence.scheduledDate}`}
  occurrence={occurrence}
/>
```

Keep current status, date, event count, source name/provider ID, and formatted recorded time.

- [ ] **Step 3: Make the Storybook transport query-only**

In `SupplementDoseEventsPanel.stories.tsx`, return only loading, error, empty, or occurrence query results. Remove the fallback manual-record response.

- [ ] **Step 4: Run focused tests and lint**

```bash
rtk pnpm vitest run --project mobile packages/mobile/components/SupplementDoseEventsPanel.test.tsx
rtk pnpm biome check packages/mobile/components/SupplementDoseEventsPanel.tsx packages/mobile/components/SupplementDoseEventsPanel.test.tsx packages/mobile/components/SupplementDoseEventsPanel.stories.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
rtk git add packages/mobile/components/SupplementDoseEventsPanel.tsx packages/mobile/components/SupplementDoseEventsPanel.test.tsx packages/mobile/components/SupplementDoseEventsPanel.stories.tsx
rtk git commit -m "refactor(mobile): make supplement history read-only"
rtk git push
```

### Task 5: Remove manual-write APIs and persistence code

**Files:**
- Modify: `packages/server/src/routers/supplements.ts`
- Modify: `packages/server/src/routers/supplements.test.ts`
- Modify: `packages/server/src/routers/supplements-sync.test.ts`
- Modify: `packages/server/src/routers/router-data.integration.test.ts`
- Modify: `packages/server/src/repositories/supplements-repository.ts`
- Modify: `packages/server/src/repositories/supplements-repository.test.ts`
- Modify: `packages/server/src/repositories/supplement-dose-events.integration.test.ts`
- Modify: `packages/server/src/repositories/test-helpers.ts`

**Interfaces:**
- Produces: `supplementsRouter` with only `list` and `occurrences`.
- Preserves: `SupplementsRepository.list(): Promise<Supplement[]>` and `SupplementsRepository.occurrences(days: number): Promise<SupplementDoseOccurrences>`.

- [ ] **Step 1: Remove mutation-only tests**

Delete the `save` and `recordDose` describe blocks and their schema-initialization cases from `supplements.test.ts`. Remove the `save` describe block from `supplements-sync.test.ts`. Remove the `supplements.save` integration round trip from `router-data.integration.test.ts`, leaving the `supplements.list` smoke test. Remove unit cases for `SupplementsRepository.save()` and `.recordDose()` while retaining `toApiSupplement`, `list()`, and `occurrences()` coverage.

This deletion follows the repository rule against adding tests that assert removed API members are absent.

- [ ] **Step 2: Reduce the tRPC router to reads**

Replace mutation-related imports and schemas so `supplements.ts` contains this router shape:

```ts
import { supplementDoseOccurrencesSchema } from "@dofek/format/supplement-dose-events";
import { z } from "zod";
import {
  SupplementsRepository,
  supplementListSchema,
} from "../repositories/supplements-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

export const supplementsRouter = router({
  list: protectedProcedure.output(supplementListSchema).query(async ({ ctx }) => {
    const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
    return repository.list();
  }),
  occurrences: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(7) }))
    .output(supplementDoseOccurrencesSchema)
    .query(async ({ ctx, input }) => {
      const repository = new SupplementsRepository(ctx.db, ctx.userId, ctx.timezone);
      return repository.occurrences(input.days);
    }),
});
```

- [ ] **Step 3: Delete write persistence from the repository**

Remove `save()` and `recordDose()` plus their private helpers, schemas, constants, and imports: `DOFEK_PROVIDER_ID`, `DOFEK_PROVIDER_NAME`, `SUPPLEMENT_DEFINITION_FIELDS`, `SupplementVersion`, `currentDoseEventRowSchema`, `insertedIdRowSchema`, `SupplementDoseConflictError`, `definitionsEqual`, `toSupplementVersion`, `isUniqueViolation`, schema table imports used only for writes, `ensureProvider`, and `nutrientAmountEntriesFromLegacyFields`.

Keep the public parsing and read surface:

```ts
export const supplementSchema = z
  .object({
    name: z.string().min(1).max(200),
    amount: z.number().positive().optional(),
    unit: z.string().max(10).optional(),
    form: z.string().optional(),
    description: z.string().optional(),
    meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
  })
  .merge(nutrientFieldsSchema.partial());

export const supplementListSchema = z.array(supplementSchema);

export class SupplementsRepository {
  // constructor unchanged
  // list() unchanged
  // occurrences() unchanged
}
```

- [ ] **Step 4: Replace retained integration setup with direct final-schema fixtures**

Add `insertSupplementDefinitionForTest` to `packages/server/src/repositories/test-helpers.ts` with this interface:

```ts
export async function insertSupplementDefinitionForTest(
  database: Database,
  values: {
    userId: string;
    name: string;
    effectiveFrom: string;
    meal?: "breakfast" | "lunch" | "dinner" | "snack" | "other";
  },
  nutrients: Record<string, number | null> = {},
): Promise<{ definitionId: string; scheduleId: string }>
```

It must insert one `fitness.supplement`, one active
`fitness.supplement_definition`, and optional
`fitness.supplement_definition_nutrient` rows. Use
`nutrientAmountEntriesFromLegacyFields` to map nutrient fixture fields.

In `supplement-dose-events.integration.test.ts`:

- Delete the immutable-versioning test because it exercises removed replacement behavior.
- Delete the manual successor/conflict test because it exercises removed manual recording.
- Seed the cross-user foreign-key test with `insertSupplementDefinitionForTest`.
- Seed the nutrition overlay test with the helper and insert an
  `auto-supplements`-attributed `taken` dose event directly. Update the expected
  `source_providers` to `["auto-supplements", "supplement-food-fixture"]` and
  assert the inserted event ID appears in
  `v_nutrition_canonical_nutrient`.
- Preserve executable Postgres coverage for ownership constraints and nutrition resolution.

- [ ] **Step 5: Run unit and database-backed focused tests**

```bash
rtk pnpm vitest run --project unit packages/server/src/routers/supplements.test.ts packages/server/src/routers/supplements-sync.test.ts packages/server/src/repositories/supplements-repository.test.ts
rtk pnpm test:integration -- packages/server/src/repositories/supplement-dose-events.integration.test.ts packages/server/src/routers/router-data.integration.test.ts
```

Expected: retained list/occurrence unit tests PASS, and direct-schema integration fixtures PASS against Postgres.

- [ ] **Step 6: Verify no manual-write call sites remain**

```bash
rtk rg -n 'supplements\.(save|recordDose)|\.recordDose\(|SupplementsRepository.*save|caller\.save\(' packages src cypress
```

Expected: no matches. References in the committed design and plan documents are allowed and are outside the searched paths.

- [ ] **Step 7: Commit and push**

```bash
rtk git add packages/server/src/routers/supplements.ts packages/server/src/routers/supplements.test.ts packages/server/src/routers/supplements-sync.test.ts packages/server/src/routers/router-data.integration.test.ts packages/server/src/repositories/supplements-repository.ts packages/server/src/repositories/supplements-repository.test.ts packages/server/src/repositories/supplement-dose-events.integration.test.ts packages/server/src/repositories/test-helpers.ts
rtk git commit -m "refactor(server): remove manual supplement writes"
rtk git push
```

### Task 6: Run cross-platform completion gates

**Files:**
- Verify only; modify changed files only if a check identifies a concrete defect.

**Interfaces:**
- Verifies the final inferred `AppRouter` is read-only and both clients compile against it.

- [ ] **Step 1: Run all changed unit/mobile tests**

```bash
rtk pnpm test:changed
```

Expected: PASS.

- [ ] **Step 2: Run repository typecheck**

```bash
rtk pnpm typecheck
```

Expected: PASS; this proves no client or story still consumes the removed mutation procedures.

- [ ] **Step 3: Run repository lint and dead-code checks**

```bash
rtk pnpm lint
rtk pnpm knip
```

Expected: PASS with no unused form, mutation, repository-write, or story code.

- [ ] **Step 4: Review the final diff and working tree**

```bash
rtk git diff --check
rtk git diff origin/main...HEAD --stat
rtk git status --short
```

Expected: no whitespace errors; only planned tracked files plus the pre-existing untracked `paseo.json`.

- [ ] **Step 5: Resolve any gate failure at its owning task**

If a gate fails, return to the task that owns the affected file, apply the
smallest correction, and use that task's explicit add/commit/push command
before rerunning all Task 6 gates. If no fixes are required, do not create an
empty commit.
