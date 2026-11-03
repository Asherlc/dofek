/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCaptureException, refitUseMutation, resetUseMutation, statusUseQuery } = vi.hoisted(
  () => ({
    mockCaptureException: vi.fn(),
    refitUseMutation: vi.fn(),
    resetUseMutation: vi.fn(),
    statusUseQuery: vi.fn(),
  }),
);

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    personalization: {
      status: {
        useQuery: statusUseQuery,
      },
      refit: {
        useMutation: refitUseMutation,
      },
      reset: {
        useMutation: resetUseMutation,
      },
    },
    useUtils: vi.fn(() => ({
      personalization: {
        status: { invalidate: vi.fn() },
      },
      pmc: { invalidate: vi.fn() },
      recovery: { invalidate: vi.fn() },
      stress: { invalidate: vi.fn() },
    })),
  },
}));

import { PersonalizationPanel } from "./PersonalizationPanel.tsx";

const defaultStressThresholds = {
  hrvThresholds: [-2, -1.5, -1],
  rhrThresholds: [2, 1.5, 1],
};

const personalizedStressThresholds = {
  hrvThresholds: [-2, -1.25, -0.5],
  rhrThresholds: [2, 1.25, 0.5],
};

const mockData = {
  isPersonalized: true,
  fittedAt: "2026-03-19T12:00:00Z",
  parameters: {
    exponentialMovingAverage: { sampleCount: 100, correlation: 0.85 },
    stressThresholds: {
      ...personalizedStressThresholds,
      sampleCount: 60,
    },
  },
  effective: {
    exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
    stressThresholds: personalizedStressThresholds,
  },
  defaults: {
    exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
    stressThresholds: defaultStressThresholds,
  },
  modelCards: [
    {
      key: "exponentialMovingAverage",
      title: "Training Load Windows",
      description: "How many days of training history are used to compute fitness and fatigue",
      status: "personalized",
      lastSuccessfulFitAt: "2026-03-18T12:00:00Z",
      lastFitSummary: "Successful fit time recorded",
      dataWindow: "Past 365 days",
      dataSufficiency: "100 qualifying days used; minimum 90 days",
      fitEvidence: "Pearson correlation: 0.850",
      uncertainty: "No calibrated uncertainty interval is available.",
      excludedData: ["Days without a nonzero performance observation", "Unfinished activities"],
    },
    {
      key: "stressThresholds",
      title: "Stress Sensitivity",
      description: "How far each threshold is from your usual baseline (in standard deviations)",
      status: "personalized",
      lastSuccessfulFitAt: null,
      lastFitSummary: "Successful fit time unavailable until this model is refit",
      dataWindow: "Past 425 days, including rolling-baseline warm-up",
      dataSufficiency: "60 qualifying days used; minimum 60 days",
      fitEvidence: "This percentile-based fit does not calculate a goodness-of-fit statistic.",
      uncertainty: "No calibrated uncertainty interval is available.",
      excludedData: ["Days without nonzero rolling variability"],
    },
  ],
};

describe("PersonalizationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refitUseMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    resetUseMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  it("surfaces the server error message", () => {
    statusUseQuery.mockReturnValue({
      error: { message: "Personalization history is unavailable" },
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    expect(screen.getByText("Personalization history is unavailable")).toBeTruthy();
  });

  it("reports incomplete model evidence and renders an actionable panel error", () => {
    statusUseQuery.mockReturnValue({
      data: { ...mockData, modelCards: mockData.modelCards.slice(0, 1) },
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    expect(
      screen.getByText(
        "Personalization model details are incomplete. Refresh and try again; contact support if this continues.",
      ),
    ).toBeTruthy();
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "personalization-model-cards",
      missingModelCard: "stressThresholds",
    });
  });

  it("renders personalized stress thresholds as deviations from baseline", () => {
    statusUseQuery.mockReturnValue({
      data: mockData,
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    expect(
      screen.getByText(
        "Heart Rate Variability (SD): -2, -1.25, -0.5 · Resting Heart Rate (SD): 2, 1.25, 0.5",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/\bms\b/)).toBeNull();
  });

  it("renders default stress thresholds without rounding away precision", () => {
    statusUseQuery.mockReturnValue({
      data: {
        ...mockData,
        isPersonalized: false,
        effective: {
          ...mockData.effective,
          stressThresholds: defaultStressThresholds,
        },
        parameters: {
          ...mockData.parameters,
          stressThresholds: null,
        },
      },
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    expect(
      screen.getByText(
        "Heart Rate Variability (SD): -2, -1.5, -1 · Resting Heart Rate (SD): 2, 1.5, 1",
      ),
    ).toBeTruthy();
  });

  it("renders the last successful model update", () => {
    statusUseQuery.mockReturnValue({
      data: mockData,
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    const card = screen.getByRole("article", {
      name: "Training Load Windows",
    });
    expect(within(card).getByText("Updated Mar 18, 2026")).toBeTruthy();
  });
});
