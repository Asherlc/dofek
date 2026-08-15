// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface QueryState {
  data: unknown;
  error: Error | null;
  isLoading: boolean;
}

const mocks = vi.hoisted<{
  captureException: ReturnType<typeof vi.fn>;
  query: QueryState;
}>(() => ({
  captureException: vi.fn(),
  query: {
    data: [{ id: "definition-1", name: "Creatine", amount: 5, unit: "g" }],
    error: null,
    isLoading: false,
  },
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ onRefresh: vi.fn(), refreshing: false }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    supplements: {
      list: { useQuery: () => mocks.query },
      occurrences: {
        useQuery: () => ({
          data: {
            occurrences: [],
            counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
          },
          error: null,
          isLoading: false,
        }),
      },
    },
    nutritionAnalytics: {
      micronutrientAdequacyV2: {
        useQuery: () => ({
          data: {
            nutrients: [
              {
                nutrientId: "vitamin_d",
                nutrient: "Vitamin D",
                unit: "mcg",
                intake: {
                  totalDailyAverage: 120,
                  foodDailyAverage: 20,
                  supplementDailyAverage: 100,
                  daysTracked: 10,
                },
                upperLimit: {
                  status: "at_or_above_limit",
                  message:
                    "Average intake over recorded days is at or above the included NIH adult upper limit. Review this intake with a doctor or pharmacist.",
                  source: {
                    agency: "NIH ODS",
                    url: "https://ods.od.nih.gov/factsheets/VitaminD-HealthProfessional/",
                  },
                },
                safetyStatus: "at_or_above_upper_limit",
              },
            ],
            professionalReview: {
              status: "professional_review_recommended",
              message:
                "Review your complete medication and supplement list with a doctor or pharmacist because supplements can interact with medications.",
              limitation:
                "Dofek does not determine whether a specific medication and supplement interact.",
              source: {
                agency: "FDA",
                url: "https://www.fda.gov/consumers/consumer-updates/mixing-medications-and-dietary-supplements-can-endanger-your-health",
              },
            },
          },
          error: null,
          isLoading: false,
        }),
      },
    },
  },
}));

describe("SupplementsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mocks.query.data = [{ id: "definition-1", name: "Creatine", amount: 5, unit: "g" }];
    mocks.query.error = null;
    mocks.query.isLoading = false;
    vi.clearAllMocks();
  });

  it("describes an empty synced supplement stack", async () => {
    mocks.query.data = [];
    const { default: SupplementsScreen } = await import("../app/supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("No synced supplements available.")).toBeTruthy();
  });

  it("preserves cached supplements during a background refresh failure", async () => {
    mocks.query.error = new Error("Supplement refresh failed.");
    const { default: SupplementsScreen } = await import("../app/supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("Creatine")).toBeTruthy();
    expect(screen.getByText("Refresh failed: Supplement refresh failed.")).toBeTruthy();
  });

  it("reports malformed synced supplements without hiding the rest of the screen", async () => {
    mocks.query.data = [{ name: 42 }];
    const { default: SupplementsScreen } = await import("../app/supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("Synced supplements could not be read.")).toBeTruthy();
    expect(screen.queryByText("No synced supplements available.")).toBeNull();
    expect(screen.getByText("Safety Context")).toBeTruthy();
    await waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());
  });

  it("renders duplicate synced supplements without duplicate React keys", async () => {
    mocks.query.data = [
      { id: "definition-1", name: "Creatine", amount: 5, unit: "g" },
      { id: "definition-2", name: "Creatine", amount: 5, unit: "g" },
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { default: SupplementsScreen } = await import("../app/supplements");

    render(<SupplementsScreen />);

    expect(screen.getAllByText("Creatine")).toHaveLength(2);
    expect(
      consoleError.mock.calls.filter(([message]) => String(message).includes("same key")),
    ).toHaveLength(0);
  });

  it("renders server-owned upper-limit and medication-review guidance", async () => {
    const { default: SupplementsScreen } = await import("../app/supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("Safety Context")).toBeTruthy();
    expect(screen.getByText(/at or above the included NIH adult upper limit/)).toBeTruthy();
    expect(screen.getByText(/complete medication and supplement list/)).toBeTruthy();
    expect(screen.getByText(/does not determine whether a specific medication/)).toBeTruthy();
    expect(screen.getByText(/over 10 recorded days/)).toBeTruthy();
  });
});
