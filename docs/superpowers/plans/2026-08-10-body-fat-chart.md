# Body Fat Percentage Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone body-fat-percentage trend chart to the web Body page and the equivalent mobile Recovery/body-composition experience.

**Architecture:** Reuse the existing server-owned body-composition rows. The web chart reads `bodyAnalytics.weightOverview.recomposition`; the mobile recovery service adds a small `bodyFat` projection from `BodyAnalyticsRepository.getRecomposition(days, endDate)`, and the mobile UI renders that projection with the existing `SparkLine`. No client computes, smooths, or aggregates body-fat values.

**Tech Stack:** TypeScript, React, React Native, tRPC/Zod, ECharts through `DofekChart`, `react-native-svg` through `SparkLine`, Vitest, Testing Library.

## Global Constraints

- Implement the feature on both `packages/web` and `packages/mobile`.
- Metric values remain server-computed; clients only render server-provided values.
- Keep body-fat data provider-agnostic and reuse the existing canonical body-composition source.
- Treat loading, error, and insufficient-data states explicitly.
- Write a failing test before each production behavior change and verify the failure before implementation.
- Keep mobile route files route-only; place tests outside `packages/mobile/app/`.
- Use shared unit/body-composition formatters; never hardcode a weight unit.
- Do not add database tables, columns, provider-specific storage, or duplicate body-composition sources.

---

### Task 1: Expose body-fat history in the mobile Recovery contract

**Files:**
- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.ts:229-239` to add the `bodyFat` output array.
- Modify: `packages/server/src/services/mobile-recovery-tab.ts:190-270` to load and return the selected-range body-fat rows.
- Test: `packages/server/src/services/mobile-recovery-tab.test.ts` for selected-range body-fat output.
- Test: `packages/server/src/contracts/mobile-dashboard-contracts.test.ts` for contract parsing of the new field.

**Interfaces:**
- Consumes: `BodyAnalyticsRepository.getRecomposition(days: RangeDays, endDate: string): Promise<BodyRecompositionRow[]>`.
- Produces: `MobileRecoveryTabResult.bodyFat: Array<{ date: string; bodyFatPct: number }>`.

- [ ] **Step 1: Write the failing service test**

Add a fixture with two body-composition rows returned by the repository and assert that `loadMobileRecoveryTab(ctx, 30, "2026-03-28")` returns:

```ts
expect(result.bodyFat).toEqual([
  { date: "2026-03-10", bodyFatPct: 21.4 },
  { date: "2026-03-20", bodyFatPct: 20.9 },
]);
```

Also assert that the repository is called with the selected range, `30`, rather than the weight trend's minimum 90-day window. Use the existing repository spies/helpers in `mobile-recovery-tab.test.ts` so the test observes the real service contract rather than mocking the client.

- [ ] **Step 2: Run the service test and verify it fails for the missing field**

Run:

```bash
pnpm exec vitest run packages/server/src/services/mobile-recovery-tab.test.ts -t "body-fat"
```

Expected: FAIL because the recovery result does not yet expose `bodyFat` or call `getRecomposition` for the selected range.

- [ ] **Step 3: Write the failing contract test**

Extend the existing valid mobile recovery fixture with:

```ts
bodyFat: [{ date: "2026-03-20", bodyFatPct: 20.9 }]
```

Parse it through `mobileRecoveryTabOutputSchema` and assert the field survives parsing with the exact date and percentage value.

- [ ] **Step 4: Run the contract test and verify it fails**

Run:

```bash
pnpm exec vitest run packages/server/src/contracts/mobile-dashboard-contracts.test.ts -t "bodyFat"
```

Expected: FAIL because the schema does not yet define the field.

- [ ] **Step 5: Add the minimal Zod output field**

Add this field next to `weight` in `mobileRecoveryTabOutputSchema`:

```ts
bodyFat: z.array(
  z.object({
    date: dateSchema,
    bodyFatPct: z.number(),
  }),
),
```

Do not add a second source of body-fat data or any derived aggregate.

- [ ] **Step 6: Load the canonical rows in the recovery service**

Add `bodyRepo.getRecomposition(days, endDate)` to the service's existing body analytics `Promise.all`, then return only the public projection:

```ts
bodyFat: bodyFat.map(({ date, bodyFatPct }) => ({ date, bodyFatPct })),
```

Keep the existing `weightDays = Math.max(days, 90)` behavior for trend weight and use the requested `days` specifically for the body-fat series.

- [ ] **Step 7: Run the focused server tests**

Run:

```bash
pnpm exec vitest run packages/server/src/services/mobile-recovery-tab.test.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts
```

Expected: PASS with no unrelated test failures.

- [ ] **Step 8: Commit the server contract change**

```bash
git add packages/server/src/contracts/mobile-dashboard-contracts.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts packages/server/src/services/mobile-recovery-tab.ts packages/server/src/services/mobile-recovery-tab.test.ts
git commit -m "feat: expose mobile body fat history"
```

### Task 2: Build the web body-fat chart component

**Files:**
- Create: `packages/web/src/components/BodyFatPercentageChart.tsx`.
- Create: `packages/web/src/components/BodyFatPercentageChart.test.tsx`.
- Create: `packages/web/src/components/BodyFatPercentageChart.stories.tsx`.

**Interfaces:**
- Consumes: `BodyRecompositionRow[]` from `packages/server/src/routers/body-analytics.ts`, plus optional `loading`.
- Produces: A standalone ECharts chart with a `Body Fat %` series and explicit insufficient-data behavior.

- [ ] **Step 1: Write the failing chart tests**

Create a jsdom test using the same `echarts-for-react` capture pattern as `BodyRecompositionChart.test.tsx`. Cover these behaviors:

1. With two rows, the chart renders and the captured option contains one line series named `Body Fat %` with values `[date, bodyFatPct]`.
2. The captured y-axis is labeled `%`.
3. The tooltip formats a value such as `20.9` as `20.9%`, includes the formatted date, and does not expose raw floating-point noise.
4. With fewer than two rows, no chart is rendered and the user sees an explicit message that at least two body-fat readings are needed.

Use the existing `UnitContext` and `DofekChart` mocking conventions; do not test ECharts internals.

- [ ] **Step 2: Run the chart tests and verify they fail**

Run:

```bash
pnpm exec vitest run packages/web/src/components/BodyFatPercentageChart.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal chart component**

Use the existing chart helpers from `chartTheme.ts` and the existing `DofekChart` component. The core option should follow this shape:

```ts
series: [
  dofekSeries.line(
    "Body Fat %",
    data.map((row) => [row.date, row.bodyFatPct] as [string, number]),
    { color: chartColors.purple },
  ),
],
yAxis: dofekAxis.value({ name: "%" }),
```

Use `formatBodyCompositionNumber` for tooltip values, `formatDateShort` for dates, and `escapeTooltipHtml` for dynamic tooltip content. Use a single-series grid and the standard Dofek tooltip/axis/legend helpers. Return the standard chart empty state for fewer than two rows and pass through `loading`.

- [ ] **Step 4: Run the chart tests and verify they pass**

Run:

```bash
pnpm exec vitest run packages/web/src/components/BodyFatPercentageChart.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Add the Storybook coverage**

Create a story with generated dated rows covering normal, loading, and empty states. Use the existing `BodyRecompositionChart.stories.tsx` data-generation and `UnitContext` patterns. Keep the story focused on chart rendering; do not add new page-level fixtures.

- [ ] **Step 6: Commit the web chart component**

```bash
git add packages/web/src/components/BodyFatPercentageChart.tsx packages/web/src/components/BodyFatPercentageChart.test.tsx packages/web/src/components/BodyFatPercentageChart.stories.tsx
git commit -m "feat: add web body fat chart"
```

### Task 3: Add the chart to the web Body page

**Files:**
- Modify: `packages/web/src/pages/BodyPage.tsx:11-18,325-352` to import and render the new chart.
- Modify: `packages/web/src/pages/BodyPage.test.tsx:10-25,105-155` to cover page wiring.

**Interfaces:**
- Consumes: `BodyFatPercentageChart` and `weightOverview.data.recomposition`.
- Produces: A Body Composition grid with Trend Weight, Recomposition, and Body Fat Percentage cards.

- [ ] **Step 1: Write the failing page integration test**

Mock `BodyFatPercentageChart` alongside the existing Body page chart mocks, returning a visible marker such as `Body fat points: {data.length}`. Render the existing healthy overview fixture and assert the Body page includes that marker with the number of recomposition rows. This test must fail before the page renders the new component.

- [ ] **Step 2: Run the page test and verify it fails**

Run:

```bash
pnpm exec vitest run packages/web/src/pages/BodyPage.test.tsx -t "body fat"
```

Expected: FAIL because the page has no Body Fat Percentage chart.

- [ ] **Step 3: Wire the chart into the existing Body Composition grid**

Import `BodyFatPercentageChart` and add a third card titled `Body Fat Percentage` inside the existing `!weightOverviewUnavailable` grid. Pass `weightOverview.data?.recomposition ?? []` and `loading={weightOverview.isLoading}`. Keep the card in the same error/loading boundary as the existing body-composition charts so the established page-level dependency notice remains the single retry surface.

- [ ] **Step 4: Run the page tests and web component tests**

Run:

```bash
pnpm exec vitest run packages/web/src/pages/BodyPage.test.tsx packages/web/src/components/BodyFatPercentageChart.test.tsx packages/web/src/components/BodyRecompositionChart.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the web page integration**

```bash
git add packages/web/src/pages/BodyPage.tsx packages/web/src/pages/BodyPage.test.tsx
git commit -m "feat: show body fat chart on web body page"
```

### Task 4: Render body-fat history on mobile Recovery

**Files:**
- Modify: `packages/mobile/app/(tabs)/recovery.tsx:230-245,640-690` to derive display-only references and render the card.
- Modify: `packages/mobile/app-tests/(tabs)/recovery.test.tsx` to cover body-fat rendering and SparkLine input.

**Interfaces:**
- Consumes: `recoveryData.bodyFat: Array<{ date: string; bodyFatPct: number }>` from Task 1.
- Produces: A `Body Fat %` card near Trend Weight, with the latest formatted percentage and a SparkLine containing the server-provided percentages.

- [ ] **Step 1: Write the failing mobile UI test**

Add a recovery fixture with two body-fat rows and assert:

```ts
expect(screen.getByText("BODY FAT %")).toBeTruthy();
expect(screen.getByText("20.9%")).toBeTruthy();
expect(sparkLinePropsCalls.some((props) => props.data?.join(",") === "21.4,20.9")).toBe(true);
```

Use the existing mocked `SparkLine` call capture. The test should verify the UI consumes the response values directly and does not need to know how they were calculated.

- [ ] **Step 2: Run the mobile test and verify it fails**

Run:

```bash
pnpm exec vitest run packages/mobile/app-tests/'(tabs)'/recovery.test.tsx -t "body fat"
```

Expected: FAIL because the recovery screen does not yet read `bodyFat` or render the card.

- [ ] **Step 3: Add display-only body-fat references**

Near the existing `weightData` references, add:

```ts
const bodyFatData = recoveryData?.bodyFat ?? [];
const latestBodyFat = bodyFatData.at(-1)?.bodyFatPct ?? null;
```

Do not calculate a trend, average, delta, or smoothed value on the client.

- [ ] **Step 4: Render the mobile body-fat card**

Place the new `Card` immediately after the Trend Weight card. Render it only when `latestBodyFat != null`; show the latest value with `${formatBodyCompositionNumber(latestBodyFat)}%` and render a `SparkLine` when at least two values exist:

```tsx
<SparkLine
  data={bodyFatData.map((row) => row.bodyFatPct)}
  height={50}
  color={colors.purple}
  showYAxis
  formatYLabel={(value) => `${formatBodyCompositionNumber(value)}%`}
/>
```

Use the existing card styles and keep the card free of client-derived summary text.

- [ ] **Step 5: Run the mobile tests**

Run:

```bash
pnpm exec vitest run packages/mobile/app-tests/'(tabs)'/recovery.test.tsx packages/server/src/services/mobile-recovery-tab.test.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the mobile UI integration**

```bash
git add 'packages/mobile/app/(tabs)/recovery.tsx' 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'
git commit -m "feat: show body fat trend on mobile recovery"
```

### Task 5: Verify the complete feature

**Files:**
- Modify: only files identified by failing checks, if a focused correction is required.
- Test: the web and mobile/server suites listed below.

- [ ] **Step 1: Run all focused feature tests**

```bash
pnpm exec vitest run \
  packages/server/src/services/mobile-recovery-tab.test.ts \
  packages/server/src/contracts/mobile-dashboard-contracts.test.ts \
  packages/web/src/components/BodyFatPercentageChart.test.tsx \
  packages/web/src/components/BodyPage.test.tsx \
  packages/mobile/app-tests/'(tabs)'/recovery.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck and lint for the touched packages**

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS without changing thresholds, suppressing rules, or adding ignores.

- [ ] **Step 3: Review the final diff and repository status**

```bash
git diff --check HEAD~5..HEAD
git status --short
```

Confirm the only untracked file still present is any pre-existing user file (currently `paseo.json`), and that no generated route files or files under `packages/mobile/app/` outside the route itself were added.

- [ ] **Step 4: Run the complete relevant test tier if focused checks pass**

```bash
pnpm test:changed
```

If the changed-test tier requires database-backed dependencies, use the repository's documented `pnpm test:changed:all` tier instead of invoking raw Compose commands.

- [ ] **Step 5: Commit any final correction and report validation**

If the final checks require a code correction, add a focused regression test first, rerun the failing command, then commit with a message describing the correction. Otherwise, report the focused tests, lint, typecheck, and changed-test results, along with the final commit IDs.
