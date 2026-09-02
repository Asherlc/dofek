// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupplementDoseEventsPanel } from "./SupplementDoseEventsPanel";

interface MockState {
  query: {
    data: {
      occurrences: Array<{
        currentEventId: string;
        scheduleId: string;
        supplementId: string;
        supplementName: string;
        scheduledDate: string;
        status: "planned" | "taken" | "skipped" | "unknown";
        history: Array<{
          id: string;
          providerId: string;
          status: "planned" | "taken" | "skipped" | "unknown";
          recordedAt: string;
          sourceName: string;
        }>;
      }>;
      counts: { planned: number; taken: number; skipped: number; unknown: number };
    };
    error: Error | null;
    isLoading: boolean;
  };
}

const mocks = vi.hoisted<MockState>(() => ({
  query: {
    data: {
      occurrences: [
        {
          currentEventId: "event-current",
          scheduleId: "schedule-1",
          supplementId: "supplement-1",
          supplementName: "Vitamin D",
          scheduledDate: "2026-07-27",
          status: "unknown" as const,
          history: [
            {
              id: "event-current",
              providerId: "auto-supplements",
              status: "unknown" as const,
              recordedAt: "2026-07-27T12:00:00.000Z",
              sourceName: "Auto-Supplements",
            },
          ],
        },
      ],
      counts: { planned: 0, taken: 0, skipped: 0, unknown: 1 },
    },
    error: null,
    isLoading: false,
  },
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    supplements: {
      occurrences: { useQuery: () => mocks.query },
    },
  },
}));

describe("SupplementDoseEventsPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    const current = mocks.query.data.occurrences[0];
    if (!current) throw new Error("Missing supplement occurrence fixture");
    current.status = "unknown";
    const history = current.history[0];
    if (!history) throw new Error("Missing supplement history fixture");
    history.status = "unknown";
    mocks.query.error = null;
    mocks.query.isLoading = false;
    vi.clearAllMocks();
  });

  it("renders status, history provenance, and counts", () => {
    render(<SupplementDoseEventsPanel />);

    expect(screen.getByText("Unknown · 1 event")).toBeTruthy();
    expect(screen.getByText("Taken 0 · Skipped 0 · Unknown 1 · Planned 0")).toBeTruthy();
    expect(screen.getByText(/Unknown · Auto-Supplements/)).toBeTruthy();
  });

  it("preserves cached occurrences during a background refresh failure", () => {
    mocks.query.error = new Error("Supplement history refresh failed.");

    render(<SupplementDoseEventsPanel />);

    expect(screen.getByText("Vitamin D")).toBeTruthy();
    expect(screen.getByText("Supplement history refresh failed.")).toBeTruthy();
  });

  it.each([
    ["planned", /^Planned · 1 event$/],
    ["taken", /^Taken · 1 event$/],
    ["skipped", /^Skipped · 1 event$/],
    ["unknown", /^Unknown · 1 event$/],
  ] as const)("renders the %s status", (status, labelPattern) => {
    const current = mocks.query.data.occurrences[0];
    if (!current) throw new Error("Missing supplement occurrence fixture");
    current.status = status;

    render(<SupplementDoseEventsPanel />);

    expect(screen.getByText(labelPattern)).toBeTruthy();
  });
});
