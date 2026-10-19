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
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", 30);
    expect(screen.getByText("Heart Rate Variability Coefficient of Variation")).toBeTruthy();

    cleanup();
    state.queryCalls.length = 0;
    state.days = null;
    await renderRoute("/training/recovery", () => import("./recovery.tsx"));
    expectRegistryInputs("recovery", null);
  });
});
