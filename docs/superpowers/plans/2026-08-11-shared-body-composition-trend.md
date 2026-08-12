# Shared Body-Composition Trend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present Weight and Body Fat through one selector-controlled summary and trend chart on web and iOS, with server-authored Body Fat estimates and projections.

**Architecture:** Generalize the existing body-weight trend calculations in `BodyAnalyticsRepository` into a metric-neutral calculation path, then expose typed weight and body-fat contracts from the existing web and mobile endpoints. Replace the separate raw Body Fat views with one reusable trend chart and summary that render the selected server response; only Weight receives energy-balance and goal fields.

**Tech Stack:** TypeScript, Vitest, Zod, tRPC, React/ECharts, React Native/react-native-svg.

## Global Constraints

- Preserve raw body-composition storage and the existing Recomposition chart.
- Compute smoothing, rate, period changes, and projection only on the server.
- Use the existing interpolation, EWMA, regression, confidence, and minimum-reading rules for both metrics.
- Body Fat uses percentage-point units and must not expose calorie, goal, or goal-date estimates.
- Maintain web/iOS parity and add tests before production code.
- Remove obsolete raw Body Fat chart components, stories, and tests rather than retaining duplicate presentation paths.

---

### Task 1: Server-author Body Fat trend and prediction data

**Files:**

- Modify: `packages/server/src/repositories/body-analytics-repository.ts`
- Modify: `packages/server/src/repositories/body-analytics-repository.test.ts`

**Interfaces:**

- Consumes: `fetchBodyWeightRows(..., { requireBodyFat: true })`, `interpolateMissingDays`, `ewmaSmooth`, and `leastSquaresSlope`.
- Produces:

  ```ts
  export interface SmoothedBodyFatRow {
    date: string;
    rawBodyFatPct: number | null;
    rawBodyFatStatus: EpistemicStatus | null;
    smoothedBodyFatPct: number;
    smoothedBodyFatStatus: EpistemicStatus;
    weeklyChange: number | null;
    interpolated: boolean;
  }

  export interface BodyFatPrediction {
    ratePerWeek: number | null;
    rateConfidence: number | null;
    periodDeltas: { days7: number | null; days14: number | null; days30: number | null };
    projectionLine: Array<{ date: string; projectedBodyFatPct: number }>;
  }

  getSmoothedBodyFat(days: RangeDays, endDate: string): Promise<SmoothedBodyFatRow[]>;
  getBodyFatPrediction(days: RangeDays, endDate: string): Promise<BodyFatPrediction>;
  ```

- The shared internal calculation takes dated raw values and metric field names, and applies the same constants that currently govern weight sufficiency. `getBodyFatPrediction` reads all available body-fat history, as `getWeightPrediction` does, so a short display range does not shorten the calculation history.

- [ ] **Step 1: Write the failing Body Fat trend tests**

  Add a fixture containing sparse dated body-fat percentages and assert that `getSmoothedBodyFat` returns calendar-day interpolation, preserves an observed raw value only on measured days, and supplies an estimated EWMA value on every returned day.

  ```ts
  it("builds an interpolated, server-authored body-fat trend", async () => {
    mockBodyRows([
      { date: "2026-03-01", weight_kg: "80", body_fat_pct: "20" },
      { date: "2026-03-03", weight_kg: "80", body_fat_pct: "22" },
    ]);

    await expect(repository.getSmoothedBodyFat(null, "2026-03-03")).resolves.toEqual([
      expect.objectContaining({
        date: "2026-03-01",
        rawBodyFatPct: 20,
        interpolated: false,
      }),
      expect.objectContaining({
        date: "2026-03-02",
        rawBodyFatPct: null,
        interpolated: true,
      }),
      expect.objectContaining({
        date: "2026-03-03",
        rawBodyFatPct: 22,
        interpolated: false,
      }),
    ]);
  });
  ```

- [ ] **Step 2: Run the trend test to verify it fails**

  Run: `pnpm vitest run packages/server/src/repositories/body-analytics-repository.test.ts -t "server-authored body-fat trend"`

  Expected: FAIL because `getSmoothedBodyFat` does not exist.

- [ ] **Step 3: Write the failing Body Fat prediction test**

  Add fourteen daily measurements decreasing from `22.0` by `0.1` percentage points per day. Assert that the prediction produces a negative rate, non-null confidence, 7-day change, and a 30-day dashed-projection input whose first point is after the last observed date.

  ```ts
  it("predicts body-fat change from the smoothed history", async () => {
    mockBodyRows(bodyFatSeries("2026-03-01", 14, (index) => 22 - index / 10));

    const prediction = await repository.getBodyFatPrediction(90, "2026-03-14");

    expect(prediction.ratePerWeek).toBeLessThan(0);
    expect(prediction.rateConfidence).not.toBeNull();
    expect(prediction.periodDeltas.days7).toBeLessThan(0);
    expect(prediction.projectionLine[0]).toEqual(
      expect.objectContaining({ date: "2026-03-15" }),
    );
  });
  ```

- [ ] **Step 4: Run the prediction test to verify it fails**

  Run: `pnpm vitest run packages/server/src/repositories/body-analytics-repository.test.ts -t "predicts body-fat change"`

  Expected: FAIL because `getBodyFatPrediction` does not exist.

- [ ] **Step 5: Implement the metric-neutral trend calculation**

  Extract the dense interpolation, EWMA, weekly-change, regression, period-delta, and projection mechanics from the current Weight methods into private generic helpers. Keep the public Weight types and values unchanged. Call the helpers from the two new Body Fat methods with `bodyFatPct` values and percentage-point rounding; do not add body-fat goal or calorie calculations.

  ```ts
  const trend = this.#computeSmoothedMetric(data, {
    alpha: 0.1,
    rawKey: "rawBodyFatPct",
    smoothedKey: "smoothedBodyFatPct",
  });
  return this.#filterTrendToSelectedRange(trend, days, endDate);
  ```

- [ ] **Step 6: Run repository tests to verify the implementation**

  Run: `pnpm vitest run packages/server/src/repositories/body-analytics-repository.test.ts`

  Expected: PASS, including the existing Weight calculation tests and the new Body Fat cases.

- [ ] **Step 7: Commit the server calculation**

  ```bash
  git add packages/server/src/repositories/body-analytics-repository.ts packages/server/src/repositories/body-analytics-repository.test.ts
  git commit -m "feat: add body fat trend prediction"
  ```

### Task 2: Extend web and mobile API contracts

**Files:**

- Modify: `packages/server/src/routers/body-analytics.ts`
- Modify: `packages/server/src/routers/body-analytics.test.ts`
- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.ts`
- Modify: `packages/server/src/contracts/mobile-dashboard-contracts.test.ts`
- Modify: `packages/server/src/services/mobile-recovery-tab.ts`
- Modify: `packages/server/src/services/mobile-recovery-tab.test.ts`

**Interfaces:**

- Consumes: `BodyAnalyticsRepository.getSmoothedBodyFat` and `getBodyFatPrediction` from Task 1.
- Produces a `bodyFatTrend` array and `bodyFatPrediction` object in both `bodyAnalytics.weightOverview` and `mobileDashboard.recovery` responses. The old mobile raw `bodyFat` array is removed, because it is superseded by `bodyFatTrend`.

- [ ] **Step 1: Write the failing router contract test**

  Add a `weightOverview` caller test that spies on the two new repository methods and expects their return values under `bodyFatTrend` and `bodyFatPrediction`.

  ```ts
  await expect(caller.weightOverview({ days: 30, endDate: "2026-03-15" })).resolves.toMatchObject({
    bodyFatTrend: [expect.objectContaining({ smoothedBodyFatPct: 20.4 })],
    bodyFatPrediction: expect.objectContaining({ ratePerWeek: -0.2 }),
  });
  ```

- [ ] **Step 2: Run the router test to verify it fails**

  Run: `pnpm vitest run packages/server/src/routers/body-analytics.test.ts -t "body fat trend"`

  Expected: FAIL because the overview output has no `bodyFatTrend` or `bodyFatPrediction` fields.

- [ ] **Step 3: Add the web response schemas and repository calls**

  Add Zod schemas mirroring Task 1’s explicit fields. Extend the overview `Promise.allSettled` work to request both Body Fat values. Treat a rejected Body Fat dependency as a body-composition error, report it to Sentry, and return the existing specific retryable tRPC error rather than sending a partial raw Body Fat series.

  ```ts
  const [smoothedWeightResult, predictionResult, recompositionResult, bodyFatTrendResult, bodyFatPredictionResult, decisionContextResult] = await Promise.allSettled([
    repo.getSmoothedWeight(range.days, input.endDate),
    repo.getWeightPrediction(predictionDays, input.endDate, goalWeightKg),
    repo.getRecomposition(range.days, input.endDate),
    repo.getSmoothedBodyFat(range.days, input.endDate),
    repo.getBodyFatPrediction(predictionDays, input.endDate),
    repo.getBodyDecisionContext(input.endDate),
  ]);
  ```

- [ ] **Step 4: Run the router test to verify it passes**

  Run: `pnpm vitest run packages/server/src/routers/body-analytics.test.ts -t "body fat trend"`

  Expected: PASS.

- [ ] **Step 5: Write the failing mobile service and contract tests**

  Replace the current raw `bodyFat` expectation with the selected-range `bodyFatTrend` and `bodyFatPrediction` values. Update the mobile contract parser test to accept the new fields and reject the removed raw-only shape.

  ```ts
  expect(result.bodyFatTrend).toEqual([
    expect.objectContaining({ date: "2026-03-20", smoothedBodyFatPct: 20.9 }),
  ]);
  expect(result.bodyFatPrediction).toEqual(expect.objectContaining({ ratePerWeek: -0.2 }));
  ```

- [ ] **Step 6: Run the mobile service and contract tests to verify failure**

  Run: `pnpm vitest run packages/server/src/services/mobile-recovery-tab.test.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts -t "body fat"`

  Expected: FAIL because the service still returns `bodyFat` and the contract has no new fields.

- [ ] **Step 7: Implement the mobile response contract**

  Load both Body Fat values in `loadMobileRecoveryTab`, return them under their new names, and update `mobileRecoveryTabOutputSchema`. Remove the old raw `bodyFat` field from the service and schema.

- [ ] **Step 8: Run focused server-contract tests to verify the implementation**

  Run: `pnpm vitest run packages/server/src/routers/body-analytics.test.ts packages/server/src/services/mobile-recovery-tab.test.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts`

  Expected: PASS.

- [ ] **Step 9: Commit the contract changes**

  ```bash
  git add packages/server/src/routers/body-analytics.ts packages/server/src/routers/body-analytics.test.ts packages/server/src/contracts/mobile-dashboard-contracts.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts packages/server/src/services/mobile-recovery-tab.ts packages/server/src/services/mobile-recovery-tab.test.ts
  git commit -m "feat: expose body fat trend contracts"
  ```

### Task 3: Create the shared web summary and chart

**Files:**

- Create: `packages/web/src/components/BodyCompositionTrendChart.tsx`
- Create: `packages/web/src/components/BodyCompositionTrendChart.test.tsx`
- Create: `packages/web/src/components/BodyCompositionTrendChart.stories.tsx`
- Create: `packages/web/src/components/BodyCompositionPredictionSummary.tsx`
- Create: `packages/web/src/components/BodyCompositionPredictionSummary.test.tsx`
- Create: `packages/web/src/components/BodyCompositionPredictionSummary.stories.tsx`
- Modify: `packages/web/src/pages/BodyPage.tsx`
- Modify: `packages/web/src/pages/BodyPage.test.tsx`
- Delete: `packages/web/src/components/BodyFatPercentageChart.tsx`
- Delete: `packages/web/src/components/BodyFatPercentageChart.test.tsx`
- Delete: `packages/web/src/components/BodyFatPercentageChart.stories.tsx`
- Delete: `packages/web/src/components/SmoothedWeightChart.tsx`
- Delete: `packages/web/src/components/SmoothedWeightChart.test.tsx`
- Delete: `packages/web/src/components/SmoothedWeightChart.stories.tsx`
- Delete: `packages/web/src/components/WeightPredictionSummary.tsx`
- Delete: `packages/web/src/components/WeightPredictionSummary.test.tsx`
- Delete: `packages/web/src/components/WeightPredictionSummary.stories.tsx`

**Interfaces:**

- Consumes the Task 2 overview fields and a discriminated metric prop:

  ```ts
  type BodyTrendDisplay =
    | { metric: "weight"; data: SmoothedWeightRow[]; prediction: WeightPrediction }
    | { metric: "bodyFat"; data: SmoothedBodyFatRow[]; prediction: BodyFatPrediction };
  ```

- Produces one chart series for raw readings, one estimated trend series, and one dashed projection series when present. The summary produces only fields present in the selected metric contract.

- [ ] **Step 1: Write the failing shared chart tests**

  Define Weight and Body Fat fixtures. Assert that the Weight chart retains `kg` labels and raw/scatter/trend/projection series; assert that the Body Fat selection uses `%`, `Raw Body Fat`, `Trend Body Fat`, and `Projection` series sourced from `smoothedBodyFatPct` and `projectedBodyFatPct`.

  ```tsx
  render(<BodyCompositionTrendChart display={bodyFatDisplay} />);

  expect(getSeries("Raw Body Fat").data).toEqual([["2026-03-01", 22]]);
  expect(getSeries("Trend Body Fat").data).toEqual([["2026-03-01", 22]]);
  expect(getSeries("Projection").lineStyle.type).toBe("dashed");
  expect(capturedOption?.yAxis[0].name).toBe("%");
  ```

- [ ] **Step 2: Run the shared chart test to verify it fails**

  Run: `pnpm vitest run packages/web/src/components/BodyCompositionTrendChart.test.tsx`

  Expected: FAIL because the shared component does not exist.

- [ ] **Step 3: Write the failing summary tests**

  Assert that Body Fat displays its rate and all available period changes with percentage-point formatting, while calorie balance and goal fields are absent. Keep the existing Weight test expectations as the Weight branch of the same component.

  ```tsx
  render(<BodyCompositionPredictionSummary display={bodyFatDisplay} />);

  expect(screen.getByText("-0.2%/wk")).toBeInTheDocument();
  expect(screen.getByText("7-Day Change")).toBeInTheDocument();
  expect(screen.queryByText("Daily Balance")).toBeNull();
  expect(screen.queryByText("Goal Estimate")).toBeNull();
  ```

- [ ] **Step 4: Run the summary test to verify it fails**

  Run: `pnpm vitest run packages/web/src/components/BodyCompositionPredictionSummary.test.tsx`

  Expected: FAIL because the shared summary component does not exist.

- [ ] **Step 5: Implement the reusable web components and stories**

  Implement the components from the discriminated `BodyTrendDisplay` union. Reuse `DofekChart`, the current ECharts styling helpers, the unit converter for Weight, and `formatBodyCompositionNumber` for Body Fat. Add one Weight and one Body Fat Storybook story for each component. Keep Body Fat's projection visually identical to Weight’s dashed projection.

- [ ] **Step 6: Run focused component tests to verify the implementation**

  Run: `pnpm vitest run packages/web/src/components/BodyCompositionTrendChart.test.tsx packages/web/src/components/BodyCompositionPredictionSummary.test.tsx`

  Expected: PASS.

- [ ] **Step 7: Write the failing BodyPage interaction test**

  Replace the existing “switches the body trend” assertion with one that proves both areas switch together: Weight renders the Weight summary and chart; clicking Body Fat removes those values and renders Body Fat summary and chart values.

  ```tsx
  render(<BodyPage />);
  expect(screen.getByText("-0.3 kg/wk")).toBeInTheDocument();
  expect(screen.getByTestId("body-trend-chart-weight")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Body Fat" }));

  expect(screen.getByText("-0.2%/wk")).toBeInTheDocument();
  expect(screen.getByTestId("body-trend-chart-body-fat")).toBeInTheDocument();
  ```

- [ ] **Step 8: Run the page test to verify it fails**

  Run: `pnpm vitest run packages/web/src/pages/BodyPage.test.tsx -t "summary and chart"`

  Expected: FAIL because the page still renders separate Weight and Body Fat surfaces.

- [ ] **Step 9: Implement the shared Web surface**

  Restore the selector layout in the single Trend card, then render `BodyCompositionPredictionSummary` and `BodyCompositionTrendChart` from the same selected `BodyTrendDisplay`. Show `GoalWeightInput` and `BodyDecisionContext` only for Weight. Default to Weight and fall back to Body Fat only when Weight has no trend data while Body Fat does. Delete the replaced three component families and update their imports.

- [ ] **Step 10: Run web component and page tests to verify the implementation**

  Run: `pnpm vitest run packages/web/src/components/BodyCompositionTrendChart.test.tsx packages/web/src/components/BodyCompositionPredictionSummary.test.tsx packages/web/src/pages/BodyPage.test.tsx`

  Expected: PASS.

- [ ] **Step 11: Commit the shared web surface**

  ```bash
  git add packages/web/src/components packages/web/src/pages/BodyPage.tsx packages/web/src/pages/BodyPage.test.tsx
  git commit -m "feat(web): share body composition trend UI"
  ```

### Task 4: Create the shared iOS Body Composition card

**Files:**

- Modify: `packages/mobile/app/(tabs)/recovery.tsx`
- Modify: `packages/mobile/app-tests/(tabs)/recovery.test.tsx`
- Modify: `packages/mobile/app-stories/(tabs)/recovery.stories.tsx`

**Interfaces:**

- Consumes `recoveryData.weight`, `recoveryData.weightPrediction`, `recoveryData.bodyFatTrend`, and `recoveryData.bodyFatPrediction` from Task 2.
- Produces one selector-controlled card where the number grid and `SparkLine` derive from the same selected metric.

- [ ] **Step 1: Write the failing mobile interaction test**

  Update the Recovery fixture with Body Fat trend/prediction data. Assert the default Weight view shows the weight rate and line, then choose Body Fat and assert the body-fat rate, period change, and chart accessibility label appear while Weight values are absent.

  ```tsx
  fireEvent.click(screen.getByRole("button", { name: "Body Fat" }));

  expect(screen.getByText("-0.2%/wk")).toBeTruthy();
  expect(screen.getByText("7-day: -0.3%" )).toBeTruthy();
  expect(screen.getByLabelText(/Body fat trend:.*projection/i)).toBeTruthy();
  expect(screen.queryByText("-0.3 kg/wk")).toBeNull();
  ```

- [ ] **Step 2: Run the mobile interaction test to verify it fails**

  Run: `pnpm vitest run packages/mobile/app-tests/'(tabs)'/recovery.test.tsx -t "summary and chart"`

  Expected: FAIL because the existing Body Fat card uses the removed raw `bodyFat` field and no prediction grid.

- [ ] **Step 3: Implement the selector-controlled mobile card**

  Replace the separate Trend Weight and Body Fat cards with one `Body Composition` card. Keep the existing selector, but drive the selected latest value, compact rate/change grid, SparkLine data, projection display, and accessibility label from a single discriminated display value. Reuse Weight's status and decision context only for Weight. Body Fat shows percent/percentage-point labels and no energy or goal elements.

  ```tsx
  const selectedBodyDisplay = displayedBodyTrendMetric === "weight"
    ? { metric: "weight" as const, trend: weightData, prediction: weightPrediction }
    : { metric: "bodyFat" as const, trend: bodyFatTrend, prediction: bodyFatPrediction };
  ```

- [ ] **Step 4: Add mobile story fixtures for both metrics**

  Update the Recovery stories with one Weight and one Body Fat selected state. Each fixture includes rate, one period change, and at least two trend values so visual review exercises both the number grid and chart.

- [ ] **Step 5: Run focused mobile tests to verify the implementation**

  Run: `pnpm vitest run packages/mobile/app-tests/'(tabs)'/recovery.test.tsx`

  Expected: PASS.

- [ ] **Step 6: Commit the shared mobile surface**

  ```bash
  git add 'packages/mobile/app/(tabs)/recovery.tsx' 'packages/mobile/app-tests/(tabs)/recovery.test.tsx' 'packages/mobile/app-stories/(tabs)/recovery.stories.tsx'
  git commit -m "feat(mobile): share body composition trend UI"
  ```

### Task 5: Verify cross-platform completion

**Files:**

- Modify only if a verification failure identifies a defect in one of the Task 1–4 files.

**Interfaces:**

- Consumes the final server response and both client renderers.
- Produces evidence that the shared server-authored Body Fat trend/prediction works on both platforms without changing Weight behavior.

- [ ] **Step 1: Run formatting and static checks**

  Run: `pnpm lint && pnpm typecheck`

  Expected: exit code 0.

- [ ] **Step 2: Run all directly affected unit suites**

  Run: `pnpm vitest run packages/server/src/repositories/body-analytics-repository.test.ts packages/server/src/routers/body-analytics.test.ts packages/server/src/services/mobile-recovery-tab.test.ts packages/server/src/contracts/mobile-dashboard-contracts.test.ts packages/web/src/components/BodyCompositionTrendChart.test.tsx packages/web/src/components/BodyCompositionPredictionSummary.test.tsx packages/web/src/pages/BodyPage.test.tsx 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'`

  Expected: exit code 0 with no failed tests.

- [ ] **Step 3: Run the changed-test tier**

  Run: `pnpm test:changed`

  Expected: exit code 0.

- [ ] **Step 4: Review the final diff for scope and dead paths**

  Run: `git diff origin/show-trend-predictions...HEAD --check && git status --short`

  Expected: no whitespace errors; no obsolete raw Body Fat chart components; only intended tracked changes.

- [ ] **Step 5: Push the task commits**

  Run: `git push`

  Expected: the remote `show-trend-predictions` branch contains the committed Task 1–4 implementation. If verification identifies a defect, return to the task owning that file, add a failing regression test first, rerun the task's focused suite, then commit and push the corrected task.
