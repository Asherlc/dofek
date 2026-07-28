// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupplementDoseEventsPanel } from "./SupplementDoseEventsPanel";

interface MutationOptions {
  onError?: (error: Error) => void;
  onSuccess?: (recorded: { scheduledDate: string }) => Promise<unknown>;
}

interface MockState {
  captureException: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  invalidateFood: ReturnType<typeof vi.fn>;
  invalidateNutrition: ReturnType<typeof vi.fn>;
  invalidateOccurrences: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
  mutationOptions?: MutationOptions;
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
  captureException: vi.fn(),
  invalidate: vi.fn(),
  invalidateFood: vi.fn(),
  invalidateNutrition: vi.fn(),
  invalidateOccurrences: vi.fn(),
  mutate: vi.fn(),
  mutationOptions: undefined,
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

vi.mock("../lib/telemetry", () => ({ captureException: mocks.captureException }));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      invalidate: mocks.invalidate,
      food: { byDateV2: { invalidate: mocks.invalidateFood } },
      nutritionAnalytics: { invalidate: mocks.invalidateNutrition },
      supplements: { occurrences: { invalidate: mocks.invalidateOccurrences } },
    }),
    supplements: {
      occurrences: { useQuery: () => mocks.query },
      recordDose: {
        useMutation: (options: typeof mocks.mutationOptions) => {
          mocks.mutationOptions = options;
          return { error: null, isError: false, isPending: false, mutate: mocks.mutate };
        },
      },
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
    mocks.mutationOptions = undefined;
    vi.clearAllMocks();
  });

  it("renders status and records a taken successor against the current leaf", () => {
    render(<SupplementDoseEventsPanel />);

    expect(screen.getByText("Unknown · 1 event")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Taken" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      expectedCurrentEventId: "event-current",
      status: "taken",
    });
  });

  it("reports record failures to telemetry", () => {
    render(<SupplementDoseEventsPanel />);
    const error = new Error("Supplement status changed. Reload and try again.");

    mocks.mutationOptions?.onError?.(error);

    expect(mocks.captureException).toHaveBeenCalledWith(error, {
      operation: "supplements.recordDose",
    });
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

  it("invalidates only supplement and nutrition query families after recording", async () => {
    render(<SupplementDoseEventsPanel />);

    await mocks.mutationOptions?.onSuccess?.({ scheduledDate: "2026-07-27" });

    expect(mocks.invalidateOccurrences).toHaveBeenCalledOnce();
    expect(mocks.invalidateFood).toHaveBeenCalledWith({ date: "2026-07-27" });
    expect(mocks.invalidateNutrition).toHaveBeenCalledOnce();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
