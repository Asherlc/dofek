/** @vitest-environment jsdom */

import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRegistryInputs,
  renderRoute,
  resetRangePlumbingState,
  state,
} from "./range-plumbing.test-helper.tsx";

vi.mock("../../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-08-01",
}));

describe("recovery route range plumbing", () => {
  beforeEach(resetRangePlumbingState);
  afterEach(cleanup);

  it("passes finite and All ranges to selected-range chart queries", async () => {
    state.days = 30;
    state.dailyMetricsQuery = {
      data: [{ date: "2026-07-31", skin_temp_c: 32.18 }],
      isLoading: false,
      error: null,
    };
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", 30);
    expect(state.queryCalls).toContainEqual(
      expect.objectContaining({
        name: "dailyMetrics.list",
        input: expect.objectContaining({ days: 30, endDate: "2026-08-01" }),
      }),
    );
    expect(screen.getByText("Heart Rate Variability Coefficient of Variation")).toBeTruthy();
    expect(screen.getByText("Skin Temperature")).toBeTruthy();
    expect(screen.getByTestId("recovery-temperature-series").textContent).toContain("32.18");

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", null);
    expect(state.queryCalls).toContainEqual(
      expect.objectContaining({
        name: "dailyMetrics.list",
        input: expect.objectContaining({ days: null, endDate: "2026-08-01" }),
      }),
    );
  });

  it("distinguishes initial loading, an empty range, and errors while keeping cached readings", async () => {
    state.dailyMetricsQuery = { data: undefined, isLoading: true, error: null };
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();

    cleanup();
    state.dailyMetricsQuery = { data: [], isLoading: false, error: null };
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expect(screen.getByText("No skin temperature data in this date range.")).toBeTruthy();

    cleanup();
    state.dailyMetricsQuery = {
      data: [{ date: "2026-07-31", skin_temp_c: 32.18 }],
      isLoading: false,
      error: new Error("Skin temperature refresh failed"),
    };
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expect(screen.getByText("Skin temperature refresh failed")).toBeTruthy();
    expect(screen.getByTestId("recovery-temperature-series").textContent).toContain("32.18");
  });
});
