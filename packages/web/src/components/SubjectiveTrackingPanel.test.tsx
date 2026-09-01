/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const injuriesResult: {
    data:
      | Array<{
          id: string;
          kind: string;
          description: string;
          severity: number | null;
          onset_date: string;
        }>
      | undefined;
    error: Error | null;
    isLoading: boolean;
  } = { data: [], error: null, isLoading: false };

  return { injuriesResult, saveCheckIn: vi.fn() };
});

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    subjective: {
      injuries: { useQuery: () => mocks.injuriesResult },
      saveCheckIn: { useMutation: () => ({ error: null, isPending: false, mutate: mocks.saveCheckIn }) },
    },
  },
}));

import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel.tsx";

describe("SubjectiveTrackingPanel", () => {
  beforeEach(() => {
    mocks.injuriesResult.data = [];
    mocks.injuriesResult.error = null;
    mocks.injuriesResult.isLoading = false;
    mocks.saveCheckIn.mockReset();
  });

  it("renders recorded injury history", () => {
    mocks.injuriesResult.data = [
      {
        id: "injury-1",
        kind: "niggle",
        description: "Morning tenderness",
        severity: 3,
        onset_date: "2026-08-01",
      },
    ];

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("niggle · Morning tenderness · 3/10 · 2026-08-01")).toBeInTheDocument();
  });

  it("renders the empty injury history state", () => {
    render(<SubjectiveTrackingPanel />);

    expect(screen.getByText("No injury events logged.")).toBeInTheDocument();
  });

  it("records an all-clear check-in with one tap", () => {
    render(<SubjectiveTrackingPanel />);

    fireEvent.click(screen.getByRole("button", { name: "All clear today" }));

    expect(mocks.saveCheckIn).toHaveBeenCalledWith({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      symptoms: [],
    });
  });

  it("renders the injury history loading state", () => {
    mocks.injuriesResult.data = undefined;
    mocks.injuriesResult.isLoading = true;

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByTestId("query-state-loading")).toBeInTheDocument();
  });

  it("renders the injury history error state", () => {
    mocks.injuriesResult.data = undefined;
    mocks.injuriesResult.error = new Error("Injury history unavailable");

    render(<SubjectiveTrackingPanel />);

    expect(screen.getByTestId("query-state-error")).toBeInTheDocument();
    expect(screen.getByText("Injury history unavailable")).toBeInTheDocument();
  });
});
