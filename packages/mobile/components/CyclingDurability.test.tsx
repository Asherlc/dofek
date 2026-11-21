// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CyclingDurability } from "./CyclingDurability";
import { cyclingDurabilityExample } from "./cycling-durability-fixtures";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("../lib/trpc", () => ({
  trpc: { cycling: { durability: { useQuery } } },
}));

afterEach(cleanup);

it("shows the same comparison and uses the active iOS range and selections", () => {
  useQuery.mockReturnValue({ data: cyclingDurabilityExample, error: null, isLoading: false });
  render(<CyclingDurability days={28} enabled units={new UnitConverter("metric")} />);

  expect(screen.getByText("24 W lower")).toBeTruthy();
  expect(screen.getByText("320 W")).toBeTruthy();
  expect(screen.getByText("296 W")).toBeTruthy();
  fireEvent.click(screen.getByText("See the rides behind these numbers"));
  expect(screen.getByText(/Estimated weight.*72.*kg/)).toBeTruthy();
  expect(screen.getAllByText("Weight readings from Nov 3, 2026")).toHaveLength(2);

  fireEvent.click(screen.getByText("Change comparison"));
  fireEvent.click(screen.getByText("1 minute"));
  fireEvent.click(screen.getByText("At least 1,440 kJ"));
  expect(useQuery).toHaveBeenLastCalledWith(
    { days: 28, durationSeconds: 60, minimumWorkKilojoulesPerKg: 20 },
    expect.objectContaining({ enabled: true }),
  );
});
