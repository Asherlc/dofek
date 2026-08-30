// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSettingsQuery = vi.hoisted(() => vi.fn());
const mockSettingsMutate = vi.hoisted(() => vi.fn());
const mockGetData = vi.hoisted(() => vi.fn());
const mockSetData = vi.hoisted(() => vi.fn());
const mockInvalidate = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/telemetry.ts", () => ({ captureException: mockCaptureException }));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    settings: {
      get: { useQuery: mockSettingsQuery },
      set: { useMutation: () => ({ mutate: mockSettingsMutate, isPending: false }) },
    },
    useUtils: () => ({
      settings: { get: { getData: mockGetData, setData: mockSetData, invalidate: mockInvalidate } },
    }),
  },
}));

import { ClimbingGradeSystemToggle } from "./ClimbingGradeSystemToggle.tsx";

beforeEach(() => {
  mockSettingsQuery.mockReturnValue({
    data: { key: "climbingGradeSystems", value: { boulder: "v_scale", route: "yds" } },
    error: null,
  });
  mockGetData.mockReturnValue({
    key: "climbingGradeSystems",
    value: { boulder: "v_scale", route: "yds" },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ClimbingGradeSystemToggle", () => {
  it("renders loading and read-error states while reporting each read failure once", async () => {
    mockSettingsQuery.mockReturnValue({ data: undefined, error: null });
    const { rerender } = render(<ClimbingGradeSystemToggle />);
    expect(screen.getByText("Loading climbing grade systems…")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    const readError = new Error("Climbing settings are unavailable.");
    mockSettingsQuery.mockReturnValue({ data: undefined, error: readError });
    rerender(<ClimbingGradeSystemToggle />);
    expect(screen.getByRole("alert")).toHaveTextContent("Climbing settings are unavailable.");
    await waitFor(() =>
      expect(mockCaptureException).toHaveBeenCalledWith(readError, {
        context: "climbing-grade-systems-read",
      }),
    );

    rerender(<ClimbingGradeSystemToggle />);
    expect(mockCaptureException).toHaveBeenCalledOnce();
  });

  it("optimistically saves each grade preference and refreshes the setting", () => {
    render(<ClimbingGradeSystemToggle />);

    fireEvent.change(screen.getByLabelText("Boulder grades"), { target: { value: "font" } });
    expect(mockSetData).toHaveBeenCalledWith(
      { key: "climbingGradeSystems" },
      { key: "climbingGradeSystems", value: { boulder: "font", route: "yds" } },
    );
    expect(mockSettingsMutate).toHaveBeenCalledWith(
      { key: "climbingGradeSystems", value: { boulder: "font", route: "yds" } },
      expect.objectContaining({ onError: expect.any(Function), onSettled: expect.any(Function) }),
    );

    const callbacks = mockSettingsMutate.mock.calls[0]?.[1];
    act(() => callbacks?.onSettled());
    expect(mockInvalidate).toHaveBeenCalledWith({ key: "climbingGradeSystems" });

    fireEvent.change(screen.getByLabelText("Route grades"), { target: { value: "french" } });
    expect(mockSettingsMutate).toHaveBeenLastCalledWith(
      { key: "climbingGradeSystems", value: { boulder: "v_scale", route: "french" } },
      expect.any(Object),
    );
  });

  it("rolls back and reports a failed preference write", () => {
    const previous = { key: "climbingGradeSystems", value: { boulder: "v_scale", route: "yds" } };
    mockGetData.mockReturnValue(previous);
    render(<ClimbingGradeSystemToggle />);

    fireEvent.change(screen.getByLabelText("Boulder grades"), { target: { value: "font" } });
    const callbacks = mockSettingsMutate.mock.calls[0]?.[1];
    const writeError = new Error("Unable to save climbing preferences.");
    act(() => callbacks?.onError(writeError));

    expect(mockSetData).toHaveBeenLastCalledWith({ key: "climbingGradeSystems" }, previous);
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to save climbing preferences.");
    expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
      context: "climbing-grade-systems-write",
    });
  });
});
