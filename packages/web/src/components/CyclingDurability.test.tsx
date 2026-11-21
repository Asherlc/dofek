/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { CyclingDurability } from "./CyclingDurability.tsx";
import {
  cyclingDurabilityDifferentWeights,
  cyclingDurabilityExample,
  cyclingDurabilityNoLateEffort,
} from "./cycling-durability-fixtures.ts";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: { cycling: { durability: { useQuery } } },
}));

describe("CyclingDurability", () => {
  afterEach(cleanup);

  beforeEach(() => {
    useQuery.mockReset();
    useQuery.mockReturnValue({ data: undefined, error: null, isLoading: true });
  });

  it("uses the active date range and comparison controls", () => {
    render(<CyclingDurability days={28} />);
    expect(screen.getByRole("heading", { name: "Power after sustained riding" })).toBeVisible();
    expect(useQuery).toHaveBeenLastCalledWith(
      { days: 28, durationSeconds: 300, minimumWorkKilojoulesPerKg: 30 },
      expect.anything(),
    );

    fireEvent.click(screen.getByText("Change comparison"));
    fireEvent.change(screen.getByLabelText("Effort length"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Pedaling before the effort"), {
      target: { value: "20" },
    });
    expect(useQuery).toHaveBeenLastCalledWith(
      { days: 28, durationSeconds: 60, minimumWorkKilojoulesPerKg: 20 },
      expect.anything(),
    );
  });

  it("shows an API failure when there is no result to display", () => {
    useQuery.mockReturnValue({
      data: undefined,
      error: new Error("Could not load cycling durability."),
      isLoading: false,
    });
    render(<CyclingDurability days={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load cycling durability.");
  });

  it("keeps an existing comparison visible alongside a refresh error", () => {
    useQuery.mockReturnValue({
      data: cyclingDurabilityExample,
      error: new Error("Could not refresh cycling durability."),
    });
    render(<CyclingDurability days={28} />);
    expect(screen.getByText("24 W lower")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh cycling durability.");
  });

  it("renders the same-weight comparison and explains the estimated weight in its evidence", () => {
    useQuery.mockReturnValue({ data: cyclingDurabilityExample, error: null, isLoading: false });
    render(<CyclingDurability days={28} />);
    expect(screen.getByText("24 W lower")).toBeVisible();
    expect(screen.getByText("320 W")).toBeVisible();
    expect(screen.getByText("296 W")).toBeVisible();
    fireEvent.click(screen.getByText("See the rides behind these numbers"));
    expect(screen.getByText(/Estimated weight.*72.*kg/)).toBeVisible();
    expect(screen.getAllByText("Weight readings from Nov 3, 2026")).toHaveLength(2);
  });

  it("uses the rider's weight display preference in the ride details", () => {
    useQuery.mockReturnValue({ data: cyclingDurabilityExample, error: null, isLoading: false });
    render(
      <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
        <CyclingDurability days={28} />
      </UnitContext.Provider>,
    );
    fireEvent.click(screen.getByText("See the rides behind these numbers"));
    expect(screen.getByText(/Estimated weight.*158\.7\s*lb/)).toBeVisible();
    expect(screen.getByText("24 W lower")).toBeVisible();
  });

  it("uses normalized power for different weights and explains missing later efforts", () => {
    useQuery.mockReturnValue({ data: cyclingDurabilityDifferentWeights });
    const { rerender } = render(<CyclingDurability days={28} />);
    expect(screen.getByText("0.55 W/kg lower")).toBeVisible();
    useQuery.mockReturnValue({ data: cyclingDurabilityNoLateEffort });
    rerender(<CyclingDurability days={28} />);
    expect(screen.getByText("No effort after this work")).toBeVisible();
    expect(screen.getByText("320 W")).toBeVisible();
  });
});
