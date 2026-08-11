# Climbing Grade Systems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently persisted boulder and route grade-system preferences, powered by Sandbag, to manual logging and all climbing displays.

**Architecture:** `@dofek/training` owns the Sandbag adapter and its domain types. The server validates and converts raw grades at its API boundary, while Postgres retains only the recorded grade and source system. Web and mobile only render server-provided display grades and use the shared adapter's grade option lists for manual input.

**Tech Stack:** TypeScript, pnpm workspace, `@openbeta/sandbag@0.0.55`, Zod, Drizzle/Postgres, tRPC, React, React Native, Vitest.

## Global Constraints

- Use `@openbeta/sandbag@0.0.55` as the single parser, validator, converter, grade-list source, and score-ordering implementation.
- Support bouldering (`v_scale`, `font`) and routes (`yds`, `french`, `uiaa`, `ewbank`, `saxon`, `norwegian`, `brazilian_crux`) only.
- Store the source grade and source system; never persist a converted grade or computed score.
- Compute display grades and sorting on the server; clients render the returned display fields.
- Implement parity on both `packages/web` and `packages/mobile`.
- Follow TDD: each behavior test must fail for the missing behavior before its implementation is written.

---

### Task 1: Replace bespoke parsing with the Sandbag-backed grade domain

**Files:**
- Modify: `packages/training/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/training/src/climbing-grades.ts`
- Modify: `packages/training/src/climbing-grades.test.ts`
- Modify: `packages/training/README.md`

**Interfaces:**
- Produces `ClimbingGradeSystem`, `ClimbingGradePreference`, `DEFAULT_CLIMBING_GRADE_PREFERENCE`, `gradeSystemsForClimbType`, `gradeOptionsForSystem`, `isValidClimbingGrade`, `convertClimbingGrade`, and `gradeSortValue` from `@dofek/training/climbing-grades`.
- `convertClimbingGrade({ grade, sourceSystem, displaySystem })` returns `{ displayGrade, displaySystem, sortValue }` or `null` for an invalid/cross-discipline grade.

- [ ] **Step 1: Write the failing domain tests.**

```ts
expect(gradeSystemsForClimbType("boulder")).toEqual(["v_scale", "font"]);
expect(gradeOptionsForSystem("font")).toContain("6a");
expect(convertClimbingGrade({ grade: "V4", sourceSystem: "v_scale", displaySystem: "font" }))
  .toMatchObject({ displaySystem: "font", displayGrade: "6a+/6b+" });
expect(convertClimbingGrade({ grade: "V4", sourceSystem: "v_scale", displaySystem: "yds" }))
  .toBeNull();
```

- [ ] **Step 2: Verify the tests fail.**

Run: `pnpm exec vitest run --project unit packages/training/src/climbing-grades.test.ts`

Expected: FAIL because the new Sandbag adapter exports do not exist.

- [ ] **Step 3: Install the reviewed dependency and implement the adapter.**

Run: `pnpm --filter @dofek/training add @openbeta/sandbag@0.0.55`

```ts
export const CLIMBING_GRADE_SYSTEMS = [
  "v_scale", "font", "yds", "french", "uiaa", "ewbank", "saxon", "norwegian", "brazilian_crux",
] as const;

export const DEFAULT_CLIMBING_GRADE_PREFERENCE = { boulder: "v_scale", route: "yds" } as const;
```

Map these stable Dofek names to Sandbag `GradeScales`, reject a target outside the source scale's conversion group, and average Sandbag score ranges for `sortValue`. Remove the regex parser rather than retaining a parallel conversion table.

- [ ] **Step 4: Verify the domain tests pass and update the package README public API table.**

Run: `pnpm exec vitest run --project unit packages/training/src/climbing-grades.test.ts && pnpm --filter @dofek/training typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the isolated domain change.**

```bash
git add packages/training/package.json packages/training/src/climbing-grades.ts packages/training/src/climbing-grades.test.ts packages/training/README.md pnpm-lock.yaml
git commit -m "feat(training): use sandbag for climbing grades"
```

### Task 2: Persist valid source systems and make climbing APIs preference-aware

**Files:**
- Create: `drizzle/0074_climbing_grade_systems.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/db/schema/enums.ts`
- Modify: `packages/server/src/routers/settings.ts`
- Create: `packages/server/src/climbing-grade-preferences.ts`
- Create: `packages/server/src/climbing-grade-preferences.test.ts`
- Modify: `packages/server/src/routers/climbing.ts`
- Modify: `packages/server/src/routers/climbing.test.ts`
- Modify: `packages/server/src/routers/climbing.integration.test.ts`
- Modify: `packages/server/src/repositories/climbing-training-log-repository.ts`
- Modify: `packages/server/src/repositories/climbing-repository.ts`
- Modify: `packages/server/src/repositories/climbing-repository.test.ts`
- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.ts`
- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.test.ts`
- Modify: `packages/server/src/services/mobile-training-tab.ts`
- Modify: `packages/server/src/services/mobile-training-tab.test.ts`

**Interfaces:**
- `CLIMBING_GRADE_PREFERENCE_SETTINGS_KEY = "climbingGradeSystems"` stores `{ boulder: BoulderGradeSystem; route: RouteGradeSystem }`.
- Climbing response grades expose `grade`, `gradeSystem`, `sourceGrade`, `sourceGradeSystem`, and `gradeSortValue`; `grade`/`gradeSystem` are display values.
- `ClimbingRepository` accepts a resolved `ClimbingGradePreference` and groups volume by display grade while retaining source-grade provenance.

- [ ] **Step 1: Write failing preference, router, and database integration tests.**

```ts
expect(resolveClimbingGradePreference(null)).toEqual(DEFAULT_CLIMBING_GRADE_PREFERENCE);
await caller.settings.set({ key: "climbingGradeSystems", value: { boulder: "font", route: "french" } });
await expect(caller.climbing.logClimbingSession(fontSession)).resolves.toBeDefined();
await expect(caller.climbing.logClimbingSession({ ...fontSession, climbs: [{ ...fontClimb, grade: "V4" }] }))
  .rejects.toMatchObject({ message: expect.stringContaining("Fontainebleau") });
```

The integration fixture inserts a `font` and a `french` grade into a real `fitness.climbing_entry`, proves Postgres accepts the extended enum, then queries the route with the opposite display preferences and asserts source provenance is retained.

- [ ] **Step 2: Verify the new tests fail.**

Run: `pnpm exec vitest run --project unit packages/server/src/climbing-grade-preferences.test.ts packages/server/src/routers/climbing.test.ts && pnpm test:integration -- packages/server/src/routers/climbing.integration.test.ts`

Expected: FAIL because the setting key, enum members, and converted fields do not exist.

- [ ] **Step 3: Add the enum migration and setting contract.**

```sql
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'font';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'french';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'uiaa';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'ewbank';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'saxon';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'norwegian';
ALTER TYPE fitness.climbing_grade_system ADD VALUE IF NOT EXISTS 'brazilian_crux';
```

Add the same values to Drizzle's enum, add a strict Zod setting union member, and resolve malformed/missing saved values to `DEFAULT_CLIMBING_GRADE_PREFERENCE` without writing a replacement.

- [ ] **Step 4: Validate logs and project API rows through the shared domain.**

```ts
.superRefine((climb, ctx) => {
  if (!isGradeSystemForClimbType(climb.gradeSystem, climb.climbType)) ctx.addIssue(...);
  if (!isValidClimbingGrade(climb.grade, climb.gradeSystem)) ctx.addIssue(...);
});
```

Load the preference once per request before constructing `ClimbingRepository`. Replace SQL's V/YDS `CASE` sorter with raw-row queries plus Sandbag score ordering in repository code. Return display fields and source fields from progression, volume, session-summary, and activity-entry results. Update mobile dashboard contracts and load the same preference in `loadMobileTrainingTab` before invoking the repository.

- [ ] **Step 5: Verify server tests pass.**

Run: `pnpm exec vitest run --project unit packages/server/src/climbing-grade-preferences.test.ts packages/server/src/repositories/climbing-repository.test.ts packages/server/src/routers/climbing.test.ts packages/server/src/services/mobile-training-tab.test.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts && pnpm test:integration -- packages/server/src/routers/climbing.integration.test.ts`

Expected: PASS; no static SQL-string assertions are added for database behavior.

- [ ] **Step 6: Commit the server and schema change.**

```bash
git add drizzle src/db/schema/enums.ts packages/server/src
git commit -m "feat(climbing): add grade display preferences"
```

### Task 3: Add web preference controls and preference-aware manual logging

**Files:**
- Create: `packages/web/src/components/ClimbingGradeSystemToggle.tsx`
- Create: `packages/web/src/components/ClimbingGradeSystemToggle.test.tsx`
- Create: `packages/web/src/components/ClimbingGradeSystemToggle.stories.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Modify: `packages/web/src/pages/SettingsPage.test.tsx`
- Modify: `packages/web/src/components/ClimbingAttemptLog.tsx`
- Modify: `packages/web/src/components/ClimbingAttemptLog.test.tsx`
- Modify: `packages/web/src/routes/training/climbing.tsx`
- Modify: `packages/web/src/routes/training/climbing.test.tsx`
- Modify: `packages/web/src/pages/activity-detail/components/ClimbingEntryBreakdown.tsx`
- Modify: `packages/web/src/components/ClimbingGradeProgressionChart.tsx`
- Modify: `packages/web/src/components/ClimbingVolumeByGradeChart.tsx`

**Interfaces:**
- `ClimbingGradeSystemToggle` receives the resolved preference and `onChange(preference)`; it is presentation-only.
- `ClimbingAttemptLog` receives `gradePreference` and submits the matching selected `gradeSystem`.

- [ ] **Step 1: Write failing component and route tests.**

```tsx
render(<ClimbingGradeSystemToggle preference={{ boulder: "v_scale", route: "yds" }} onChange={onChange} />);
fireEvent.change(screen.getByLabelText("Boulder grade system"), { target: { value: "font" } });
expect(onChange).toHaveBeenCalledWith({ boulder: "font", route: "yds" });

render(<ClimbingAttemptLog gradePreference={{ boulder: "font", route: "french" }} ... />);
expect(screen.getByRole("option", { name: "6A" })).toBeInTheDocument();
```

- [ ] **Step 2: Verify the tests fail.**

Run: `pnpm exec vitest run --project unit packages/web/src/components/ClimbingGradeSystemToggle.test.tsx packages/web/src/components/ClimbingAttemptLog.test.tsx packages/web/src/pages/SettingsPage.test.tsx packages/web/src/routes/training/climbing.test.tsx`

Expected: FAIL because the selector and preference props do not exist.

- [ ] **Step 3: Implement the web controls and render server display values.**

```tsx
<select aria-label="Boulder grade system" value={preference.boulder} onChange={...}>
  {gradeSystemsForClimbType("boulder").map((system) => <option value={system}>{gradeSystemLabel(system)}</option>)}
</select>
```

Fetch and save `climbingGradeSystems` with the same optimistic-cache rollback/error behavior as `UnitProvider`. Pass the preference into the climbing logger. Replace free-text grade entry with the shared system's valid grade options. Render `grade`/`gradeSystem` returned by the server in chart labels and detail badges; do not convert grades in the browser.

- [ ] **Step 4: Verify web tests and build typecheck pass.**

Run: `pnpm exec vitest run --project unit packages/web/src/components/ClimbingGradeSystemToggle.test.tsx packages/web/src/components/ClimbingAttemptLog.test.tsx packages/web/src/pages/SettingsPage.test.tsx packages/web/src/routes/training/climbing.test.tsx && pnpm --dir packages/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the web change.**

```bash
git add packages/web/src
git commit -m "feat(web): select climbing grade systems"
```

### Task 4: Add mobile preference controls and preference-aware manual logging

**Files:**
- Modify: `packages/mobile/app/settings.tsx`
- Modify: `packages/mobile/app-tests/settings.test.tsx`
- Modify: `packages/mobile/app/climbing-log.tsx`
- Modify: `packages/mobile/components/ClimbingAttemptLog.tsx`
- Modify: `packages/mobile/components/ClimbingAttemptLog.test.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/strain.test.tsx`
- Modify: `packages/mobile/app-tests/activity/[id].test.tsx`

**Interfaces:**
- The mobile settings screen reads/writes `climbingGradeSystems` and rolls back its cached setting after a failed mutation.
- The mobile logger receives `gradePreference`, offers its valid grades by selected climb type, and submits the corresponding source system.

- [ ] **Step 1: Write failing screen and logger tests.**

```tsx
fireEvent.press(screen.getByLabelText("Boulder grade system Fontainebleau"));
expect(setSettingMutation).toHaveBeenCalledWith({
  key: "climbingGradeSystems",
  value: { boulder: "font", route: "yds" },
});

render(<ClimbingAttemptLog gradePreference={{ boulder: "font", route: "french" }} ... />);
fireEvent.press(screen.getByLabelText("Grade 6A"));
fireEvent.press(screen.getByLabelText("Save climbing session"));
expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
  climbs: [expect.objectContaining({ grade: "6A", gradeSystem: "font" })],
}));
```

- [ ] **Step 2: Verify the tests fail.**

Run: `pnpm exec vitest run --project unit packages/mobile/components/ClimbingAttemptLog.test.tsx packages/mobile/app-tests/settings.test.tsx packages/mobile/app-tests/\(tabs\)/strain.test.tsx packages/mobile/app-tests/activity/\[id\].test.tsx`

Expected: FAIL because the mobile preference state and grade-option picker do not exist.

- [ ] **Step 3: Implement mobile selectors and renderer parity.**

```tsx
<OptionGroup
  label="Boulder grade system"
  options={gradeSystemsForClimbType("boulder").map((value) => ({ value, label: gradeSystemLabel(value) }))}
  selected={preference.boulder}
  onSelect={(boulder) => savePreference({ ...preference, boulder })}
/>
```

Place both controls in Goals & Models alongside Units. Add the grade option picker to `ClimbingAttemptLog`, reset the selected grade when climb type or its preference changes, and pass the fetched preference from `climbing-log.tsx`. Use the server-provided display `grade` fields in strain and activity details; do not add conversion logic to mobile.

- [ ] **Step 4: Verify mobile tests and typecheck pass.**

Run: `pnpm exec vitest run --project unit packages/mobile/components/ClimbingAttemptLog.test.tsx packages/mobile/app-tests/settings.test.tsx packages/mobile/app-tests/\(tabs\)/strain.test.tsx packages/mobile/app-tests/activity/\[id\].test.tsx && pnpm --dir packages/mobile typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the mobile change.**

```bash
git add packages/mobile
git commit -m "feat(mobile): select climbing grade systems"
```

### Task 5: Whole-feature verification and handoff

**Files:**
- Modify only files required by failed lint/type/test checks from Tasks 1–4.

- [ ] **Step 1: Run full affected unit suite.**

Run: `pnpm test:changed`

Expected: PASS.

- [ ] **Step 2: Run database-backed feature validation.**

Run: `pnpm test:integration -- packages/server/src/routers/climbing.integration.test.ts`

Expected: PASS with the current workspace Compose dependencies.

- [ ] **Step 3: Run static checks.**

Run: `pnpm lint && pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Inspect the final change and commit any verification fixes.**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and no unrelated files staged.

- [ ] **Step 5: Push the completed branch.**

Run: `git push`
