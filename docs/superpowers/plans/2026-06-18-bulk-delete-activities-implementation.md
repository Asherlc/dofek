# Bulk Delete Activities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build cross-platform bulk deletion for activities from the web and mobile activities lists.

**Architecture:** Add one protected `activity.bulkDelete` mutation that delegates to `ActivityRepository.bulkDelete`, keeping the current deduped-group deletion semantics. Web and mobile use explicit select mode and invalidate their own list queries after success.

**Tech Stack:** TypeScript, tRPC, Drizzle SQL, Vitest, React, React Native, Expo Router.

---

### Task 1: Server Bulk Delete API

**Files:**
- Modify: `packages/server/src/repositories/activity-repository.ts`
- Test: `packages/server/src/repositories/activity-repository.test.ts`
- Modify: `packages/server/src/routers/activity.ts`
- Test: `packages/server/src/routers/activity.test.ts`

- [ ] **Step 1: Write failing repository tests**

Add tests under `describe("delete")` in `packages/server/src/repositories/activity-repository.test.ts`:

```ts
it("bulkDelete skips SQL when no activity ids are provided", async () => {
  const { repo, execute } = makeRepository([]);
  await expect(repo.bulkDelete([])).resolves.toBe(0);
  expect(execute).not.toHaveBeenCalled();
});

it("bulkDelete deduplicates selected activity ids and deletes every member activity in matching deduped groups", async () => {
  const { repo, execute } = makeRepository([]);

  await expect(repo.bulkDelete(["activity-id", "activity-id", "other-id"])).resolves.toBe(2);

  const sqlObject = execute.mock.calls[0]?.[0];
  const compiledQuery = dialect.sqlToQuery(sqlObject);
  expect(compiledQuery.sql).toContain("DELETE FROM fitness.activity");
  expect(compiledQuery.sql).toContain("selected_member.member_activity_id IN");
  expect(compiledQuery.sql).toContain("member_rows.member_activity_id");
  expect(compiledQuery.params).toEqual(expect.arrayContaining(["activity-id", "other-id", "user-1"]));
});
```

- [ ] **Step 2: Run repository tests to verify they fail**

Run: `pnpm vitest run packages/server/src/repositories/activity-repository.test.ts`

Expected: FAIL because `bulkDelete` is not defined.

- [ ] **Step 3: Implement repository bulk delete**

Add `bulkDelete(activityIds: string[]): Promise<number>` to `ActivityRepository`, and make `delete(activityId)` call it:

```ts
async delete(activityId: string): Promise<void> {
  await this.bulkDelete([activityId]);
}

async bulkDelete(activityIds: string[]): Promise<number> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return 0;
  await this.db.execute(sql`
    DELETE FROM fitness.activity
    WHERE id IN (
      SELECT member_rows.member_activity_id
      FROM fitness.v_activity a
      JOIN fitness.v_activity_members selected_member ON selected_member.activity_id = a.id
      JOIN fitness.v_activity_members member_rows ON member_rows.activity_id = a.id
      WHERE selected_member.member_activity_id IN (${sql.join(
        uniqueActivityIds.map((activityId) => sql`${activityId}::uuid`),
        sql`, `,
      )})
        AND a.user_id = ${this.userId}
    )
    AND user_id = ${this.userId}
  `);
  return uniqueActivityIds.length;
}
```

- [ ] **Step 4: Write failing router tests**

Add tests under `describe("delete")` in `packages/server/src/routers/activity.test.ts`:

```ts
it("bulkDelete returns the deduplicated selected count", async () => {
  const execute = vi.fn().mockResolvedValue([]);
  const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
  const result = await caller.bulkDelete({
    ids: [
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ],
  });
  expect(result).toEqual({ success: true, deletedCount: 2 });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("bulkDelete throws PRECONDITION_FAILED when activity views are missing", async () => {
  const execute = vi.fn().mockRejectedValue(
    Object.assign(new Error('relation "fitness.v_activity" does not exist'), { code: "42P01" }),
  );
  const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
  await expect(
    caller.bulkDelete({ ids: ["00000000-0000-0000-0000-000000000001"] }),
  ).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message:
      "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
  });
});
```

- [ ] **Step 5: Run router tests to verify they fail**

Run: `pnpm vitest run packages/server/src/routers/activity.test.ts`

Expected: FAIL because `activity.bulkDelete` is not defined.

- [ ] **Step 6: Implement router mutation**

Add `bulkDelete` to `activityRouter` next to `delete`:

```ts
bulkDelete: protectedProcedure
  .input(z.object({ ids: z.array(z.string().uuid()).min(1) }))
  .mutation(async ({ ctx, input }) => {
    const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
    try {
      const deletedCount = await repo.bulkDelete(input.ids);
      return { success: true, deletedCount };
    } catch (error) {
      if (isRelationMissingError(error)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
        });
      }
      throw error;
    }
  }),
```

- [ ] **Step 7: Run server tests to verify green**

Run:

```bash
pnpm vitest run packages/server/src/repositories/activity-repository.test.ts packages/server/src/routers/activity.test.ts
```

Expected: PASS.

### Task 2: Web ActivityList Select Mode

**Files:**
- Modify: `packages/web/src/components/ActivityTable.tsx`
- Modify: `packages/web/src/components/ActivityList.tsx`
- Test: `packages/web/src/components/ActivityList.test.tsx`
- Modify: `packages/web/src/components/RecentActivitiesSection.tsx`
- Create: `packages/web/src/components/ActivityList.stories.tsx`

- [ ] **Step 1: Write failing ActivityList tests**

Add tests proving select mode does not navigate, selection can be submitted, and errors render:

```ts
it("toggles selected activities instead of navigating in select mode", () => {
  const onBulkDelete = vi.fn();
  renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);
  fireEvent.click(screen.getByText("Select"));
  const row = screen.getByText("Morning Run").closest("tr");
  if (!row) throw new Error("Row not found");
  fireEvent.click(row);
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(screen.getByText("1 selected")).toBeDefined();
});

it("confirms bulk delete with selected ids", () => {
  const onBulkDelete = vi.fn();
  renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);
  fireEvent.click(screen.getByText("Select"));
  fireEvent.click(screen.getByText("Morning Run"));
  fireEvent.click(screen.getByText("Delete"));
  fireEvent.click(screen.getByText("Confirm Delete"));
  expect(onBulkDelete).toHaveBeenCalledWith(["1"]);
});

it("shows bulk delete errors from the server", () => {
  renderWithUnits(
    <ActivityList activities={mockActivities} onBulkDelete={vi.fn()} bulkDeleteError="Cannot delete activity." />,
  );
  expect(screen.getByText("Cannot delete activity.")).toBeDefined();
});
```

- [ ] **Step 2: Run web tests to verify they fail**

Run: `pnpm vitest run packages/web/src/components/ActivityList.test.tsx`

Expected: FAIL because selection UI is missing.

- [ ] **Step 3: Implement table row click override**

Add optional `onRowClick` and `isRowSelected` props to `ActivityTable`. Use `onRowClick(row)` when provided; otherwise keep the current navigation behavior.

- [ ] **Step 4: Implement ActivityList select mode**

Add props:

```ts
onBulkDelete?: (ids: string[]) => void;
bulkDeletePending?: boolean;
bulkDeleteError?: string | null;
```

Use local `selectMode`, `selectedActivityIds`, and `confirmDelete` state. Add a checkbox column in select mode and call `onBulkDelete([...selectedActivityIds])` after confirmation.

- [ ] **Step 5: Wire RecentActivitiesSection mutation**

Use `trpc.activity.bulkDelete.useMutation` in `RecentActivitiesSection`. On success, invalidate `trpcUtils.activity.list` and reset the current page if needed.

- [ ] **Step 6: Add ActivityList stories**

Create `ActivityList.stories.tsx` with default, loading, empty, and select mode stories.

- [ ] **Step 7: Run web tests to verify green**

Run: `pnpm vitest run packages/web/src/components/ActivityList.test.tsx`

Expected: PASS.

### Task 3: Mobile Activities Select Mode

**Files:**
- Modify: `packages/mobile/app/(tabs)/activities.tsx`
- Test: `packages/mobile/app/(tabs)/activities.test.tsx`

- [ ] **Step 1: Write failing mobile tests**

Add tests for select mode, confirmed delete, and invalidation.

- [ ] **Step 2: Run mobile tests to verify they fail**

Run: `pnpm vitest run packages/mobile/app/\\(tabs\\)/activities.test.tsx`

Expected: FAIL because select mode is missing.

- [ ] **Step 3: Implement select mode in mobile activities screen**

Add `selectedActivityIds`, `selectMode`, `bulkDeleteError`, and `trpc.activity.bulkDelete.useMutation`. Toggle selection in select mode; navigate normally otherwise. Use `Alert.alert` for confirmation.

- [ ] **Step 4: Run mobile tests to verify green**

Run: `pnpm vitest run packages/mobile/app/\\(tabs\\)/activities.test.tsx`

Expected: PASS.

### Task 4: Verification and PR Update

**Files:**
- Commit all implementation files and this plan.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/server/src/repositories/activity-repository.test.ts packages/server/src/routers/activity.test.ts packages/web/src/components/ActivityList.test.tsx packages/mobile/app/\\(tabs\\)/activities.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typechecks**

Run:

```bash
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`

Expected: PASS, or same local ClickHouse credential blocker in `lint:analytics-sql` documented in the PR.

- [ ] **Step 4: Commit and push**

Run:

```bash
git add docs/superpowers/plans/2026-06-18-bulk-delete-activities-implementation.md packages/server/src/repositories/activity-repository.ts packages/server/src/repositories/activity-repository.test.ts packages/server/src/routers/activity.ts packages/server/src/routers/activity.test.ts packages/web/src/components/ActivityTable.tsx packages/web/src/components/ActivityList.tsx packages/web/src/components/ActivityList.test.tsx packages/web/src/components/ActivityList.stories.tsx packages/web/src/components/RecentActivitiesSection.tsx packages/mobile/app/\\(tabs\\)/activities.tsx packages/mobile/app/\\(tabs\\)/activities.test.tsx
git commit -m "feat: add bulk activity deletion"
git push
```

Expected: branch updates PR #1287.
