// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSettingsQuery = vi.hoisted(() => vi.fn());
const mockSetGoalWeightUseMutation = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());
const mockWeightOverviewInvalidate = vi.hoisted(() => vi.fn());
const mockWeightPredictionInvalidate = vi.hoisted(() => vi.fn());
const mockSettingsInvalidate = vi.hoisted(() => vi.fn());
const mockUseUnitConverter = vi.hoisted(() => vi.fn());

vi.mock("@dofek/format/units", () => ({
  formatMeasurementText: (value: string) => value,
}));

vi.mock("../lib/unitContext.ts", () => ({ useUnitConverter: mockUseUnitConverter }));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    settings: { get: { useQuery: mockSettingsQuery } },
    bodyAnalytics: { setGoalWeight: { useMutation: mockSetGoalWeightUseMutation } },
    useUtils: () => ({
      bodyAnalytics: {
        weightOverview: { invalidate: mockWeightOverviewInvalidate },
        weightPrediction: { invalidate: mockWeightPredictionInvalidate },
      },
      settings: { invalidate: mockSettingsInvalidate },
    }),
  },
}));

import { GoalWeightInput } from "./GoalWeightInput.tsx";

const kilograms = {
  weightLabel: "kg",
  convertWeight: (value: number) => value,
  formatWeight: (value: number) => `${value.toFixed(1)} kg`,
};

beforeEach(() => {
  mockSettingsQuery.mockReturnValue({ data: { value: "70.25" } });
  mockUseUnitConverter.mockReturnValue(kilograms);
  mockSetGoalWeightUseMutation.mockImplementation(() => ({ mutate: mockMutate, isPending: false }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GoalWeightInput", () => {
  it("edits and clears a saved kilogram goal", () => {
    render(<GoalWeightInput />);

    expect(screen.getByText("Goal: 70.3 kg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("spinbutton")).toHaveValue(70.3);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "68.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mockMutate).toHaveBeenCalledWith({ weightKg: 68.4 });

    const mutationOptions = mockSetGoalWeightUseMutation.mock.calls[0]?.[0];
    act(() => mutationOptions?.onSuccess());
    expect(mockWeightOverviewInvalidate).toHaveBeenCalledOnce();
    expect(mockWeightPredictionInvalidate).toHaveBeenCalledOnce();
    expect(mockSettingsInvalidate).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(mockMutate).toHaveBeenLastCalledWith({ weightKg: null });
  });

  it("validates input and saves pounds as kilograms", () => {
    mockSettingsQuery.mockReturnValue({ data: { value: "not-a-weight" } });
    mockUseUnitConverter.mockReturnValue({
      weightLabel: "lbs",
      convertWeight: (value: number) => value * 2.20462,
      formatWeight: (value: number) => `${value.toFixed(1)} lbs`,
    });

    render(<GoalWeightInput />);
    fireEvent.click(screen.getByRole("button", { name: "Set Goal Weight" }));

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(input, { target: { value: "not-a-number" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockMutate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "154.3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockMutate).toHaveBeenCalledWith({ weightKg: 154.3 / 2.20462 });
  });

  it("shows mutation errors and clears editing with cancel or escape", () => {
    render(<GoalWeightInput />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const mutationOptions = mockSetGoalWeightUseMutation.mock.calls[0]?.[0];
    act(() => mutationOptions?.onError(new Error("Goal weight is outside the supported range.")));
    expect(screen.getByText("Goal weight is outside the supported range.")).toBeTruthy();

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "69" } });
    expect(screen.queryByText("Goal weight is outside the supported range.")).toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("prevents duplicate saves while the goal mutation is pending", () => {
    mockSetGoalWeightUseMutation.mockReturnValue({ mutate: mockMutate, isPending: true });

    render(<GoalWeightInput />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
