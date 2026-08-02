// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccessibilityInfo } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface QueryState {
  data: Array<{ name: string; amount?: number; unit?: string }> | undefined;
  error: Error | null;
  isLoading: boolean;
}

interface SaveOptions {
  meta?: unknown;
  onError?: (error: Error) => void;
  onSuccess?: () => void;
}

const mocks = vi.hoisted<{
  captureException: ReturnType<typeof vi.fn>;
  invalidateAll: ReturnType<typeof vi.fn>;
  safetyInvalidate: ReturnType<typeof vi.fn>;
  stackInvalidate: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
  query: QueryState;
  saveOptions: SaveOptions | undefined;
}>(() => ({
  captureException: vi.fn(),
  invalidateAll: vi.fn(),
  safetyInvalidate: vi.fn(),
  stackInvalidate: vi.fn(),
  mutate: vi.fn(),
  query: {
    data: [{ name: "Creatine", amount: 5, unit: "g" }],
    error: null,
    isLoading: false,
  },
  saveOptions: undefined,
}));

vi.mock("../lib/telemetry", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ onRefresh: vi.fn(), refreshing: false }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      invalidate: mocks.invalidateAll,
      nutritionAnalytics: {
        micronutrientAdequacyV2: { invalidate: mocks.safetyInvalidate },
      },
      supplements: { list: { invalidate: mocks.stackInvalidate } },
    }),
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
      recordDose: {
        useMutation: () => ({
          error: null,
          isError: false,
          isPending: false,
          mutate: vi.fn(),
        }),
      },
      save: {
        useMutation: (options: typeof mocks.saveOptions) => {
          mocks.saveOptions = options;
          return {
            error: null,
            isError: false,
            isPending: false,
            mutate: mocks.mutate,
          };
        },
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
  afterEach(cleanup);

  beforeEach(() => {
    mocks.query.data = [{ name: "Creatine", amount: 5, unit: "g" }];
    mocks.query.error = null;
    mocks.query.isLoading = false;
    mocks.saveOptions = undefined;
    vi.clearAllMocks();
  });

  it("disables replacement actions when a previously loaded stack fails to reload", async () => {
    const { default: SupplementsScreen } = await import("./supplements");
    const { rerender } = render(<SupplementsScreen />);

    mocks.query.data = undefined;
    mocks.query.error = new Error("Supplement stack is unavailable.");
    rerender(<SupplementsScreen />);

    expect(screen.getByText("Supplement stack is unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No supplements configured/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add Supplement" })).toHaveProperty("disabled", true);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("preserves cached supplements during a background refresh failure", async () => {
    mocks.query.error = new Error("Supplement refresh failed.");
    const { default: SupplementsScreen } = await import("./supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("Creatine")).toBeTruthy();
    expect(screen.getByText("Refresh failed: Supplement refresh failed.")).toBeTruthy();
  });

  it("renders persistent labeled move controls and announces a successful reorder", async () => {
    mocks.query.data = [
      { name: "Creatine", amount: 5, unit: "g" },
      { name: "Vitamin D", amount: 25, unit: "mcg" },
    ];
    const { default: SupplementsScreen } = await import("./supplements");

    render(<SupplementsScreen />);

    const moveDown = screen.getByRole("button", { name: "Move Creatine down" });
    expect(moveDown.textContent).toBe("Move down");
    expect(screen.getByRole("button", { name: "Move Vitamin D up" })).toBeTruthy();

    fireEvent.click(moveDown);

    expect(mocks.mutate).toHaveBeenCalledWith({
      supplements: [
        { name: "Vitamin D", amount: 25, unit: "mcg" },
        { name: "Creatine", amount: 5, unit: "g" },
      ],
    });

    await act(async () => {
      await mocks.saveOptions?.onSuccess?.();
    });

    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      "Moved Creatine to position 2 of 2.",
    );
    expect(screen.getByText("Moved Creatine to position 2 of 2.")).toBeTruthy();
  });

  it("reports failed replacement mutations", async () => {
    const saveError = new Error("Supplement stack changed. Reload and try again.");
    const { default: SupplementsScreen } = await import("./supplements");
    render(<SupplementsScreen />);

    mocks.saveOptions?.onError?.(saveError);

    expect(mocks.saveOptions?.meta).toEqual({ errorReportedLocally: true });
    expect(mocks.captureException).toHaveBeenCalledWith(saveError, {
      operation: "supplements.save",
    });
  });

  it("invalidates the stack and safety review after replacement succeeds", async () => {
    const { default: SupplementsScreen } = await import("./supplements");
    render(<SupplementsScreen />);

    await mocks.saveOptions?.onSuccess?.();

    expect(mocks.stackInvalidate).toHaveBeenCalledOnce();
    expect(mocks.safetyInvalidate).toHaveBeenCalledWith({ days: 30 });
  });

  it("renders server-owned upper-limit and medication-review guidance", async () => {
    const { default: SupplementsScreen } = await import("./supplements");

    render(<SupplementsScreen />);

    expect(screen.getByText("Safety Context")).toBeTruthy();
    expect(screen.getByText(/at or above the included NIH adult upper limit/)).toBeTruthy();
    expect(screen.getByText(/complete medication and supplement list/)).toBeTruthy();
    expect(screen.getByText(/does not determine whether a specific medication/)).toBeTruthy();
    expect(screen.getByText(/over 10 recorded days/)).toBeTruthy();
  });
});
