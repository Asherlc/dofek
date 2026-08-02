# Personal Experiment Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add raw daily experiment check-ins and server-derived, evidence-first outcome analysis with web/mobile parity.

**Architecture:** A new raw check-in table and a nullable life-event association store only user-authored context. `PersonalExperimentsRepository` joins those rows with the bounded canonical correlation metric pipeline, builds a complete local-calendar observation spine, then calculates descriptive means, coverage, bootstrap uncertainty, and limitations on demand.

**Tech Stack:** TypeScript, Drizzle schema/SQL migration, Postgres, existing ClickHouse-backed correlation repository, tRPC, React, React Native, Vitest.

## Global Constraints

- One raw check-in per experiment per local calendar day; adherence is exactly `adherent`, `partial`, `not_adherent`, or `unknown`.
- Store only raw adherence, confounder, and note; never store outcome observations, effects, coverage, uncertainty, or limitations.
- Reuse `fitness.life_events` with nullable experiment association; do not add an annotations text table.
- Resolve the configured outcome only via the canonical metric pipeline; retain explicit missing days and source provenance.
- Keep calculations server-owned and render the same tRPC contract on web and mobile.
- Do not add MCP; tRPC is the complete shared-client API boundary for this slice.

---

### Task 1: Establish failing server behavior tests

**Files:**
- Create: `packages/server/src/personal-experiments/experiment-analysis.test.ts`
- Modify: `packages/server/src/repositories/personal-experiments-repository.test.ts`
- Modify: `packages/server/src/routers/personal-experiments.test.ts`

**Interfaces:**
- Produces `buildExperimentAnalysis(experiment, checkIns, canonicalOutcomes)` with calendar observations, coverage, descriptive effect, uncertainty, and limitations.
- Produces repository and router expectations for an upserted raw check-in and derived analysis.

- [x] **Step 1: Write failing pure analysis tests**

```ts
expect(buildExperimentAnalysis(experiment, checkIns, canonicalOutcomes)).toMatchObject({
  availability: "available",
  effect: { differenceInMeans: 4, baselineMean: 20, interventionMean: 24 },
  coverage: { baseline: { expectedDays: 5 }, intervention: { expectedDays: 5 } },
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `rtk pnpm --dir packages/server vitest run src/personal-experiments/experiment-analysis.test.ts`

Expected: FAIL because the analysis module does not exist.

- [x] **Step 3: Add failing repository/router tests**

```ts
await caller.checkIn({ id: experimentId, date: "2026-08-04", adherence: "partial" });
expect(await caller.get({ id: experimentId })).toMatchObject({
  checkIns: [{ date: "2026-08-04", adherence: "partial" }],
});
```

- [x] **Step 4: Run the focused tests to verify the intended failure**

Run: `rtk pnpm --dir packages/server vitest run src/repositories/personal-experiments-repository.test.ts src/routers/personal-experiments.test.ts`

Expected: FAIL because `checkIn` and derived analysis are absent.

### Task 2: Add raw storage and server contract

**Files:**
- Modify: `src/db/schema/events.ts`
- Create: `drizzle/0067_personal_experiment_learning_loop.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `packages/server/src/personal-experiments/experiment-analysis.ts`
- Modify: `packages/server/src/repositories/personal-experiments-repository.ts`
- Modify: `packages/server/src/routers/personal-experiments.ts`
- Modify: `packages/server/src/repositories/life-events-repository.ts`
- Modify: `packages/server/src/routers/life-events.ts`
- Test: `packages/server/src/repositories/personal-experiments-repository.integration.test.ts`

**Interfaces:**
- `checkIn({ date, adherence, confounder, note })` inserts or replaces a raw record at that experiment/date.
- `get`/`list` return `checkIns` and server-derived `analysis` without persisting analysis fields.
- Life-event writes accept nullable `personalExperimentId` and return it.

- [x] **Step 1: Implement only the schema required by the failing tests**

```sql
CREATE TABLE fitness.personal_experiment_check_in (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  personal_experiment_id uuid NOT NULL REFERENCES fitness.personal_experiment(id) ON DELETE CASCADE,
  date date NOT NULL,
  adherence text NOT NULL,
  confounder text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_experiment_check_in_adherence_valid
    CHECK (adherence IN ('adherent', 'partial', 'not_adherent', 'unknown')),
  CONSTRAINT personal_experiment_check_in_experiment_date_unique
    UNIQUE (personal_experiment_id, date)
);
ALTER TABLE fitness.life_events ADD COLUMN personal_experiment_id uuid
  REFERENCES fitness.personal_experiment(id) ON DELETE SET NULL;
```

- [x] **Step 2: Implement the pure calendar-spine analysis and repository data access**

```ts
const effect = interventionValues.length >= 5 && baselineValues.length >= 5
  ? mean(interventionValues) - mean(baselineValues)
  : null;
```

- [x] **Step 3: Implement the tRPC check-in and analysis schemas/procedures**

```ts
checkIn: protectedProcedure.input(z.object({
  id: z.guid(), date: dateStringSchema, adherence: adherenceSchema,
  confounder: z.string().trim().min(1).nullable(), note: z.string().trim().min(1).nullable(),
})).mutation(async ({ ctx, input }) => {
  const repository = new PersonalExperimentsRepository(ctx.db, ctx.userId, ctx.timezone, ctx.sensorStore);
  return repository.upsertCheckIn(input.id, input);
})
```

- [ ] **Step 4: Run focused unit and database behavior tests** — focused unit tests passed; real-database verification is blocked by Docker's exhausted predefined address pools before the test database can be created.

Run: `rtk pnpm --dir packages/server vitest run src/personal-experiments/experiment-analysis.test.ts src/repositories/personal-experiments-repository.test.ts src/routers/personal-experiments.test.ts && rtk pnpm test:integration -- packages/server/src/repositories/personal-experiments-repository.integration.test.ts`

Expected: PASS, including uniqueness/upsert and server-derived outcome behavior against the real database.

### Task 3: Add failing web/mobile presentation tests and implement parity

**Files:**
- Modify: `packages/web/src/pages/PersonalExperimentsPage.tsx`
- Modify: `packages/web/src/pages/PersonalExperimentsPage.test.tsx`
- Modify: `packages/mobile/app/experiments.tsx`
- Modify: `packages/mobile/app/experiments.test.tsx`

**Interfaces:**
- Both clients call `personalExperiments.checkIn` and render server-provided observations, effect, coverage, uncertainty, and limitations.

- [x] **Step 1: Write failing UI tests**

```tsx
expect(screen.getByText("Record today’s check-in")).toBeTruthy();
expect(screen.getByText(/4 of 5 intervention outcomes observed/)).toBeTruthy();
expect(screen.getByText(/Not a causal conclusion/)).toBeTruthy();
```

- [x] **Step 2: Run the presentation tests to verify failure**

Run: `rtk pnpm --dir packages/web vitest run src/pages/PersonalExperimentsPage.test.tsx && rtk pnpm --dir packages/mobile vitest run app/experiments.test.tsx`

Expected: FAIL because check-in/evidence UI is absent.

- [x] **Step 3: Implement the minimal parity UI**

```tsx
<button onClick={() => checkInMutation.mutate({ id, date: today, adherence, confounder, note })}>
  Record today’s check-in
</button>
```

- [x] **Step 4: Run presentation tests to verify they pass**

Run: `rtk pnpm --dir packages/web vitest run src/pages/PersonalExperimentsPage.test.tsx && rtk pnpm --dir packages/mobile vitest run app/experiments.test.tsx`

Expected: PASS with server-authored evidence and error messages visible on both platforms.

### Task 4: Document and verify the finished slice

**Files:**
- Modify: `docs/personal-experiments.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/schema.md`

- [x] **Step 1: Document the raw/derived boundary, source and missing-day semantics, and MCP exclusion**

- [x] **Step 2: Run focused tests, server/web/mobile type checks, changed-file lint, migration lint, and repository unit tier**

Run: `rtk pnpm lint:changed && rtk pnpm --dir packages/server tsc --noEmit && rtk pnpm --dir packages/web tsc --noEmit && rtk pnpm --dir packages/mobile tsc --noEmit && rtk pnpm test:changed`

Expected: PASS.

- [x] **Step 3: Inspect the complete diff, perform an independent requirement review, and commit the implementation** — inline review used because a reviewer subagent is unavailable; database integration remains blocked by Docker network address-pool exhaustion.

```bash
rtk git diff --check
rtk git status --short
rtk git add <only issue files>
rtk git commit -m "feat: add experiment learning loop"
```
