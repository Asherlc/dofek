# Body Composition Metric Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing body-composition trend surface switch between Trend Weight and Body Fat on web and mobile.

**Architecture:** Both clients already receive server-authored weight and body-fat series. Each screen owns a local selected metric state and conditionally renders existing metric-specific presentations, preserving server contracts and no longer showing the two metrics as independent cards.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, Tailwind CSS, React Native.

## Global Constraints

- Keep metric calculation and trend data server-authored; clients only select and render existing values.
- Implement the same behavior in `packages/web` and `packages/mobile`.
- Start with a failing behavior test before production code.
- Keep Weight selected by default and make selected state accessible.
- Do not add API, database, or dependency changes.

---

### Task 1: Web body-composition switch

**Files:**
- Modify: `packages/web/src/pages/BodyPage.test.tsx`
- Modify: `packages/web/src/pages/BodyPage.tsx`

**Interfaces:**
- Consumes: `weightOverview.data.smoothedWeight` and `weightOverview.data.recomposition` already returned by `bodyAnalytics.weightOverview`.
- Produces: a screen-local Weight / Body Fat selection that conditionally renders the existing `SmoothedWeightChart` or `BodyFatPercentageChart`.

- [ ] **Step 1: Write the failing test**

```tsx
it("switches the body trend from weight to body fat", () => {
  render(<BodyPage />);
  fireEvent.click(screen.getByRole("button", { name: "Body Fat" }));
  expect(screen.getByText("Body fat points: 1")).toBeTruthy();
  expect(screen.queryByText("Smoothed weight points: 1")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/web/src/pages/BodyPage.test.tsx`

Expected: FAIL because the Body Fat selection control does not exist.

- [ ] **Step 3: Write minimal implementation**

```tsx
const [trendMetric, setTrendMetric] = useState<"weight" | "bodyFat">("weight");
{trendMetric === "weight" ? <SmoothedWeightChart data={smoothedWeightData} /> : <BodyFatPercentageChart data={recomposition} />}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/web/src/pages/BodyPage.test.tsx`

Expected: PASS.

### Task 2: Mobile body-composition switch

**Files:**
- Modify: `packages/mobile/app-tests/(tabs)/recovery.test.tsx`
- Modify: `packages/mobile/app/(tabs)/recovery.tsx`

**Interfaces:**
- Consumes: `recoveryData.weight` and `recoveryData.bodyFat` already returned by the mobile recovery contract.
- Produces: a screen-local Weight / Body Fat selection that conditionally renders the existing weight or body-fat card contents.

- [ ] **Step 1: Write the failing test**

```tsx
it("switches the recovery body trend to body fat", async () => {
  render(<RecoveryScreen />);
  fireEvent.press(screen.getByRole("button", { name: "Body Fat" }));
  expect(screen.getByText("20.0%")).toBeTruthy();
  expect(screen.queryByText("79.8 kg")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'`

Expected: FAIL because the Body Fat selection control does not exist.

- [ ] **Step 3: Write minimal implementation**

```tsx
const [trendMetric, setTrendMetric] = useState<"weight" | "bodyFat">("weight");
{trendMetric === "weight" ? <View>{/* existing weight content */}</View> : <View>{/* existing body-fat content */}</View>}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'`

Expected: PASS.

### Task 3: Verify and ship

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-body-composition-metric-switch-design.md`
- Modify: `docs/superpowers/plans/2026-08-11-body-composition-metric-switch.md`

- [ ] **Step 1: Run focused tests**

Run: `pnpm vitest run packages/web/src/pages/BodyPage.test.tsx 'packages/mobile/app-tests/(tabs)/recovery.test.tsx'`

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run: `pnpm lint && pnpm tsc --noEmit && pnpm test`

Expected: PASS.

- [ ] **Step 3: Commit, push, and open the PR**

Run: `git push -u origin HEAD`, then create the pull-request description in a temporary markdown file and pass its path to `gh pr create --body-file`.

Expected: PR open and all required checks pass.
