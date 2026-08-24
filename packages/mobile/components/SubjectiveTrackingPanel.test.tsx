/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = { onSuccess?: () => void };

const mocks = vi.hoisted(() => {
  const regionsResult: {
    data: Array<{ id: string; label: string }> | undefined;
    error: Error | null;
    isLoading: boolean;
  } = {
    data: [{ id: "left_hand", label: "Left hand" }],
    error: null,
    isLoading: false,
  };

  return {
    captureException: vi.fn(),
    createInjury: vi.fn(),
    invokeMutationSuccess: false,
    injuriesResult: { data: [], error: null, isLoading: false },
    injuriesInvalidate: vi.fn(),
    timelineInvalidate: vi.fn(),
    regionsResult,
  };
});

vi.mock("../lib/telemetry", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/useTodayQueryDate", () => ({ useTodayQueryDate: () => "2026-08-02" }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      subjective: {
        injuries: { invalidate: mocks.injuriesInvalidate },
        timeline: { invalidate: mocks.timelineInvalidate },
      },
    }),
    subjective: {
      createInjury: {
        useMutation: (options: MutationOptions) => ({
          error: null,
          isPending: false,
          mutate: (input: unknown) => {
            mocks.createInjury(input);
            if (mocks.invokeMutationSuccess) options.onSuccess?.();
          },
        }),
      },
      injuries: { useQuery: () => mocks.injuriesResult },
      regions: { useQuery: () => mocks.regionsResult },
    },
  },
}));

import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel";

describe("SubjectiveTrackingPanel", () => {
  beforeEach(() => {
    mocks.captureException.mockReset();
    mocks.createInjury.mockReset();
    mocks.invokeMutationSuccess = false;
    mocks.injuriesInvalidate.mockReset();
    mocks.timelineInvalidate.mockReset();
    mocks.regionsResult.data = [{ id: "left_hand", label: "Left hand" }];
    mocks.regionsResult.error = null;
    mocks.regionsResult.isLoading = false;
    mocks.injuriesResult.data = [];
    mocks.injuriesResult.error = null;
    mocks.injuriesResult.isLoading = false;
  });

  it("creates an injury with an explicit zero severity", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByLabelText("Choose injury body region"));
    fireEvent.click(screen.getByRole("button", { name: "Left hand" }));
    fireEvent.change(screen.getByLabelText("Injury description"), {
      target: { value: "No pain at rest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add injury" }));

    expect(mocks.createInjury).toHaveBeenCalledWith({
      bodyRegionId: "left_hand",
      description: "No pain at rest",
      kind: "niggle",
      onsetDate: "2026-08-02",
      resolvedDate: null,
      severity: 0,
    });
  });

  it("uses editable injury dates", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByLabelText("Choose injury body region"));
    fireEvent.click(screen.getByRole("button", { name: "Left hand" }));
    fireEvent.change(screen.getByLabelText("Injury onset date"), {
      target: { value: "2026-07-31" },
    });
    fireEvent.change(screen.getByLabelText("Injury resolution date"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Injury description"), {
      target: { value: "Resolved soreness" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add injury" }));

    expect(mocks.createInjury).toHaveBeenCalledWith(
      expect.objectContaining({
        onsetDate: "2026-07-31",
        resolvedDate: "2026-08-01",
      }),
    );
  });

  it("invalidates injury data after a successful mutation", () => {
    mocks.invokeMutationSuccess = true;
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByLabelText("Choose injury body region"));
    fireEvent.click(screen.getByRole("button", { name: "Left hand" }));
    fireEvent.change(screen.getByLabelText("Injury description"), {
      target: { value: "Morning pain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add injury" }));

    expect(mocks.injuriesInvalidate).toHaveBeenCalledTimes(1);
    expect(mocks.timelineInvalidate).toHaveBeenCalledTimes(1);
  });

  it("does not submit an injury without an onset date", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByLabelText("Choose injury body region"));
    fireEvent.click(screen.getByRole("button", { name: "Left hand" }));
    fireEvent.change(screen.getByLabelText("Injury onset date"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Injury description"), {
      target: { value: "Missing onset" },
    });

    const addButton = screen.getByRole("button", { name: "Add injury" });
    expect(addButton).toHaveProperty("disabled", true);
    fireEvent.click(addButton);
    expect(mocks.createInjury).not.toHaveBeenCalled();
  });

  it("shows a region query error instead of enabling an empty selector", () => {
    mocks.regionsResult.data = undefined;
    mocks.regionsResult.error = new Error("Regions unavailable");

    render(<SubjectiveTrackingPanel />);

    expect(screen.getAllByTestId("query-state-error")).toHaveLength(1);
    expect(screen.getByText("Regions unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add injury" })).toHaveProperty("disabled", true);
  });
});
