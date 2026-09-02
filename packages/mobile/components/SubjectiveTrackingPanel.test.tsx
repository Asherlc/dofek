/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const injuriesResult: {
    data:
      | Array<{ id: string; kind: string; description: string; severity: number | null }>
      | undefined;
    error: Error | null;
    isLoading: boolean;
  } = { data: [], error: null, isLoading: false };
  const regionsResult: {
    data: Array<{ id: string; label: string }>;
    error: Error | null;
  } = { data: [{ id: "left-finger", label: "Left finger" }], error: null };

  return {
    createInjury: vi.fn(),
    invalidateInjuries: vi.fn(),
    injuriesResult,
    regionsResult,
    saveCheckIn: vi.fn(),
  };
});

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      subjective: { injuries: { invalidate: mocks.invalidateInjuries } },
    }),
    subjective: {
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
    mocks.injuriesResult.data = [];
    mocks.injuriesResult.error = null;
    mocks.injuriesResult.isLoading = false;
    mocks.saveCheckIn.mockReset();
    mocks.createInjury.mockReset();
    mocks.invalidateInjuries.mockReset();
    mocks.regionsResult.error = null;
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

  it("renders a body-region loading error", () => {
    mocks.regionsResult.error = new Error("Body regions unavailable");

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("Body regions unavailable")).toBeTruthy();
  });
});
