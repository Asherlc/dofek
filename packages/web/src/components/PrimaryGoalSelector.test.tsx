// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockSettingsQuery {
  data: { key: string; value: unknown } | undefined;
  error: Error | null;
  isLoading: boolean;
}

const mocks = vi.hoisted(() => {
  const query: MockSettingsQuery = {
    data: undefined,
    error: null,
    isLoading: false,
  };
  return {
    captureException: vi.fn(),
    getData: vi.fn(),
    invalidate: vi.fn(),
    mutate: vi.fn(),
    query,
    setData: vi.fn(),
    useQuery: vi.fn(),
  };
});

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    settings: {
      get: { useQuery: mocks.useQuery },
      set: { useMutation: () => ({ mutate: mocks.mutate }) },
    },
    useUtils: () => ({
      settings: {
        get: {
          getData: mocks.getData,
          invalidate: mocks.invalidate,
          setData: mocks.setData,
        },
      },
    }),
  },
}));

import { PrimaryGoalSelector } from "./PrimaryGoalSelector.tsx";

describe("PrimaryGoalSelector", () => {
  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.getData.mockReset();
    mocks.invalidate.mockReset();
    mocks.mutate.mockReset();
    mocks.setData.mockReset();
    mocks.useQuery.mockReset();
    mocks.useQuery.mockReturnValue(mocks.query);
    mocks.query.data = undefined;
    mocks.query.error = null;
    mocks.query.isLoading = false;
  });

  it("renders the four primary goal options", () => {
    render(<PrimaryGoalSelector />);

    expect(screen.getByRole("heading", { name: "Primary goal" })).toBeTruthy();
    expect(screen.getByText("Race preparation")).toBeTruthy();
    expect(screen.getByText("Sleep consistency")).toBeTruthy();
    expect(screen.getByText("Strength progression")).toBeTruthy();
    expect(screen.getByText("Weight trend")).toBeTruthy();
  });

  it("highlights the currently selected goal", () => {
    mocks.query.data = { key: "primaryGoal", value: "sleepConsistency" };
    render(<PrimaryGoalSelector />);

    expect(
      screen.getByRole("button", { name: /Sleep consistency/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /Race preparation/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("writes the selected goal with optimistic cache update", () => {
    mocks.query.data = { key: "primaryGoal", value: "racePreparation" };
    mocks.getData.mockReturnValue(mocks.query.data);
    render(<PrimaryGoalSelector />);

    fireEvent.click(screen.getByRole("button", { name: /Weight trend/ }));

    expect(mocks.setData).toHaveBeenCalledWith(
      { key: "primaryGoal" },
      { key: "primaryGoal", value: "weightTrend" },
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      { key: "primaryGoal", value: "weightTrend" },
      expect.objectContaining({
        onError: expect.any(Function),
        onSettled: expect.any(Function),
      }),
    );
  });

  it("restores the cached goal and displays the server error when a write fails", () => {
    const previousSetting = { key: "primaryGoal", value: "racePreparation" };
    mocks.query.data = previousSetting;
    mocks.getData.mockReturnValue(previousSetting);
    render(<PrimaryGoalSelector />);

    fireEvent.click(screen.getByRole("button", { name: /Strength progression/ }));

    const options = mocks.mutate.mock.calls[0]?.[1];
    const writeError = new Error("Primary goal was not saved.");
    act(() => options.onError(writeError));
    act(() => options.onSettled());

    expect(mocks.setData).toHaveBeenLastCalledWith({ key: "primaryGoal" }, previousSetting);
    expect(mocks.invalidate).toHaveBeenCalledWith({ key: "primaryGoal" });
    expect(screen.getByRole("alert").textContent).toBe(writeError.message);
    expect(mocks.captureException).toHaveBeenCalledWith(writeError, {
      context: "primary-goal-write",
    });
  });

  it("keeps the selected goal visible and displays a background read error", async () => {
    const readError = new Error("Primary goal could not be loaded.");
    mocks.query.data = { key: "primaryGoal", value: "weightTrend" };
    mocks.query.error = readError;
    render(<PrimaryGoalSelector />);

    expect(screen.getByRole("button", { name: /Weight trend/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("alert").textContent).toBe(readError.message);
    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(readError, {
        context: "primary-goal-read",
      }),
    );
  });
});
