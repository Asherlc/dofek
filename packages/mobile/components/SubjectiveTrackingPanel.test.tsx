/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const regionData: Array<{ id: string; label: string }> | undefined = [
    { id: "left_hand", label: "Left hand" },
  ];
  const regionError: Error | null = null;
  return {
    captureException: vi.fn(),
    checkInResult: { data: { logged: false, symptoms: [] }, error: null, isLoading: false },
    createInjury: vi.fn(),
    saveCheckIn: vi.fn(),
    injuriesResult: { data: [], error: null, isLoading: false },
    invalidate: vi.fn(),
    regionsResult: {
      data: regionData,
      error: regionError,
      isLoading: false,
    },
  };
});

vi.mock("../lib/telemetry", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/useTodayQueryDate", () => ({ useTodayQueryDate: () => "2026-08-02" }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      subjective: {
        checkIn: { invalidate: mocks.invalidate },
        injuries: { invalidate: mocks.invalidate },
        timeline: { invalidate: mocks.invalidate },
      },
    }),
    subjective: {
      checkIn: { useQuery: () => mocks.checkInResult },
      createInjury: {
        useMutation: () => ({ error: null, isPending: false, mutate: mocks.createInjury }),
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
    mocks.captureException.mockReset();
    mocks.createInjury.mockReset();
    mocks.saveCheckIn.mockReset();
    mocks.invalidate.mockReset();
    mocks.regionsResult.data = [{ id: "left_hand", label: "Left hand" }];
    mocks.regionsResult.error = null;
    mocks.regionsResult.isLoading = false;
    mocks.checkInResult.data = { logged: false, symptoms: [] };
    mocks.checkInResult.error = null;
    mocks.checkInResult.isLoading = false;
    mocks.injuriesResult.data = [];
    mocks.injuriesResult.error = null;
    mocks.injuriesResult.isLoading = false;
  });

  it("creates an injury with an explicit zero severity", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByLabelText("Choose body region"));
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

    fireEvent.click(screen.getByLabelText("Choose body region"));
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

  it("preserves unsaved symptoms when the check-in refetches", () => {
    const view = render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByLabelText("Choose body region"));
    fireEvent.click(screen.getByRole("button", { name: "Add symptom" }));

    mocks.checkInResult.data = { logged: false, symptoms: [] };
    view.rerender(<SubjectiveTrackingPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: "2026-08-02",
      symptoms: [{ bodyRegionId: "left_hand", kind: "soreness", score: 1 }],
    });
  });

  it("shows a region query error instead of enabling an empty selector", () => {
    mocks.regionsResult.data = undefined;
    mocks.regionsResult.error = new Error("Regions unavailable");

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(screen.getByText("Regions unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add injury" })).toHaveProperty("disabled", true);
  });
});
