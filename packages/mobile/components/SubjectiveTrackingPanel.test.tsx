/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createInjuryOptions: {
    current: { onSuccess?: () => void | Promise<void> } | undefined;
  } = { current: undefined };
  const injuriesResult: {
    data:
      | Array<{ id: string; kind: string; description: string; severity: number | null }>
      | undefined;
    error: Error | null;
    isLoading: boolean;
  } = { data: [], error: null, isLoading: false };
  const regionsResult: {
    data: Array<{ id: string; label: string }> | undefined;
    error: Error | null;
  } = { data: [{ id: "left-finger", label: "Left finger" }], error: null };

  return {
    createInjury: vi.fn(),
    createInjuryOptions,
    invalidateInjuries: vi.fn(),
    injuriesResult,
    regionsResult,
    saveCheckIn: vi.fn(),
  };
});

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ subjective: { injuries: { invalidate: mocks.invalidateInjuries } } }),
    subjective: {
      createInjury: {
        useMutation: (options: typeof mocks.createInjuryOptions.current) => {
          mocks.createInjuryOptions.current = options;
          return { error: null, isPending: false, mutate: mocks.createInjury };
        },
      },
      injuries: { useQuery: () => mocks.injuriesResult },
      regions: { useQuery: () => mocks.regionsResult },
      saveCheckIn: {
        useMutation: () => ({ error: null, isPending: false, mutate: mocks.saveCheckIn }),
      },
    },
  },
}));

import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel";

describe("SubjectiveTrackingPanel", () => {
  beforeEach(() => {
    mocks.injuriesResult.data = [];
    mocks.injuriesResult.error = null;
    mocks.injuriesResult.isLoading = false;
    mocks.regionsResult.data = [{ id: "left-finger", label: "Left finger" }];
    mocks.regionsResult.error = null;
    mocks.invalidateInjuries.mockReset().mockResolvedValue(undefined);
    mocks.createInjuryOptions.current = undefined;
    mocks.saveCheckIn.mockReset();
    mocks.createInjury.mockReset();
  });

  it("renders recorded injury history", () => {
    mocks.injuriesResult.data = [
      { id: "injury-1", kind: "niggle", description: "Morning tenderness", severity: 3 },
    ];

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("niggle: Morning tenderness (3/10)")).toBeTruthy();
  });

  it("renders the empty injury history state", () => {
    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("No injury events logged.")).toBeTruthy();
  });

  it("records an all-clear check-in with one tap", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByRole("button", { name: "All clear today" }));

    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      symptoms: [],
    });
  });

  it("uses the device-local date without UTC serialization", () => {
    const toISOString = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
      throw new Error("UTC serialization is not allowed");
    });
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByRole("button", { name: "All clear today" }));

    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      symptoms: [],
    });
    toISOString.mockRestore();
  });

  it("records a free-text injury note with a body-region tag", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Body region Left finger" }));
    fireEvent.change(screen.getByLabelText("Injury note"), {
      target: { value: "A2 tenderness after climbing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log injury note" }));

    expect(mocks.createInjury).toHaveBeenCalledWith({
      bodyRegionId: "left-finger",
      description: "A2 tenderness after climbing",
      kind: "niggle",
      onsetDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      resolvedDate: null,
      severity: null,
    });
  });

  it("refreshes injury history and clears the form after an injury is created", async () => {
    render(<SubjectiveTrackingPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Body region Left finger" }));
    fireEvent.change(screen.getByLabelText("Injury note"), { target: { value: "Tender" } });

    await act(async () => {
      await mocks.createInjuryOptions.current?.onSuccess?.();
    });

    expect(mocks.invalidateInjuries).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Injury note")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Log injury note" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("renders the body-region loading error", () => {
    mocks.regionsResult.data = undefined;
    mocks.regionsResult.error = new Error("Body regions unavailable");

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("Body regions unavailable")).toBeTruthy();
  });

  it("renders the injury history loading state", () => {
    mocks.injuriesResult.data = undefined;
    mocks.injuriesResult.isLoading = true;

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("renders the injury history error state", () => {
    mocks.injuriesResult.data = undefined;
    mocks.injuriesResult.error = new Error("Injury history unavailable");

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(screen.getByText("Injury history unavailable")).toBeTruthy();
  });
});
