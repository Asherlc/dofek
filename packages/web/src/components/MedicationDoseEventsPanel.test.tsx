/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listUseQuery } = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    medicationDoseEvents: {
      list: {
        useQuery: listUseQuery,
      },
    },
  },
}));

import { MedicationDoseEventsPanel } from "./MedicationDoseEventsPanel.tsx";

describe("MedicationDoseEventsPanel", () => {
  beforeEach(() => {
    listUseQuery.mockReset();
  });

  it("renders medication dose events", () => {
    listUseQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        events: [
          {
            id: "event-1",
            providerId: "apple_health",
            medicationName: "Metformin 500 mg",
            medicationConceptId: "rxnorm-123",
            doseStatus: "taken",
            recordedAt: "2026-06-29T15:30:00.000Z",
            sourceName: "Apple Health",
          },
        ],
      },
    });

    render(<MedicationDoseEventsPanel />);

    expect(screen.getByText("Metformin 500 mg")).toBeTruthy();
    expect(screen.getByText("Taken")).toBeTruthy();
    expect(screen.getByText("Apple Health")).toBeTruthy();
  });

  it("uses the shared query state panel while loading", () => {
    listUseQuery.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
    });

    render(<MedicationDoseEventsPanel />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("uses the shared query state panel for errors", () => {
    listUseQuery.mockReturnValue({
      isLoading: false,
      error: new Error("Provider query failed"),
      data: undefined,
    });

    render(<MedicationDoseEventsPanel />);

    expect(screen.getByTestId("query-state-error")).toBeTruthy();
    expect(screen.getByText("Provider query failed")).toBeTruthy();
  });

  it("uses the shared query state panel when no events exist", () => {
    listUseQuery.mockReturnValue({
      isLoading: false,
      error: null,
      data: { events: [] },
    });

    render(<MedicationDoseEventsPanel />);

    expect(screen.getByTestId("query-state-empty")).toBeTruthy();
    expect(screen.getByText("No medication dose events yet.")).toBeTruthy();
  });
});
