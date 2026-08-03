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
    readinessWeights: { sampleCount: 90, correlation: 0.75 },
    sleepTarget: { sampleCount: 30 },
    stressThresholds: {
      ...personalizedStressThresholds,
      sampleCount: 60,
    },
    trainingImpulseConstants: { sampleCount: 50, r2: 0.9 },
  },
  effective: {
    exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
    readinessWeights: { hrv: 0.4, restingHr: 0.2, sleep: 0.3, respiratoryRate: 0.1 },
    sleepTarget: { minutes: 480 },
    stressThresholds: personalizedStressThresholds,
    trainingImpulseConstants: { genderFactor: 1, exponent: 1.9 },
  },
  defaults: {
    exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
    readinessWeights: { hrv: 0.3, restingHr: 0.2, sleep: 0.3, respiratoryRate: 0.2 },
    sleepTarget: { minutes: 480 },
    stressThresholds: defaultStressThresholds,
    trainingImpulseConstants: { genderFactor: 1, exponent: 1.9 },
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
      key: "readinessWeights",
      title: "Readiness Score Weights",
      description: "How much each factor contributes to your daily readiness score",
      status: "personalized",
      lastSuccessfulFitAt: null,
      lastFitSummary: "Successful fit time unavailable until this model is refit",
      dataWindow: "Past 365 days after a 60-day rolling-baseline warm-up",
      dataSufficiency: "90 qualifying days used; minimum 60 days",
      fitEvidence: "Pearson correlation: 0.750",
      uncertainty: "No calibrated uncertainty interval is available.",
      excludedData: ["Days without heart-rate variability or resting heart rate"],
    },
    {
      key: "sleepTarget",
      title: "Sleep Target",
      description: "The amount of sleep associated with your best recovery",
      status: "personalized",
      lastSuccessfulFitAt: null,
      lastFitSummary: "Successful fit time unavailable until this model is refit",
      dataWindow: "Past 365 days; next-day recovery uses up to 60 days of baseline history",
      dataSufficiency: "30 qualifying nights used; minimum 14 nights",
      fitEvidence: "This average-based fit does not calculate a goodness-of-fit statistic.",
      uncertainty: "No calibrated uncertainty interval is available.",
      excludedData: ["Naps and shorter duplicate sleep sessions"],
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
    {
      key: "trainingImpulseConstants",
      title: "Heart Rate Effort Model",
      description: "How heart rate intensity translates to training load",
      status: "personalized",
      lastSuccessfulFitAt: null,
      lastFitSummary: "Successful fit time unavailable until this model is refit",
      dataWindow: "All qualifying activities; the power reference uses the past 365 days",
      dataSufficiency: "50 qualifying activities used; minimum 20 activities",
      fitEvidence: "R²: 0.900",
      uncertainty: "No calibrated uncertainty interval is available.",
      excludedData: ["Activities without heart-rate samples or normalized power"],
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
      data: { ...mockData, modelCards: mockData.modelCards.slice(0, 4) },
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
      missingModelCard: "trainingImpulseConstants",
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
        "How far each threshold is from your usual baseline (in standard deviations)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Heart Rate Variability: -2, -1.25, -0.5 · Resting Heart Rate: 2, 1.25, 0.5",
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
      screen.getByText("Heart Rate Variability: -2, -1.5, -1 · Resting Heart Rate: 2, 1.5, 1"),
    ).toBeTruthy();
  });

  it("renders server-built model evidence without deriving confidence", () => {
    statusUseQuery.mockReturnValue({
      data: mockData,
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    const card = screen.getByRole("article", {
      name: "Training Load Windows model evidence",
    });
    expect(within(card).getByText("Past 365 days")).toBeTruthy();
    expect(within(card).getByText("100 qualifying days used; minimum 90 days")).toBeTruthy();
    expect(within(card).getByText("Pearson correlation: 0.850")).toBeTruthy();
    expect(within(card).getByText("No calibrated uncertainty interval is available.")).toBeTruthy();
    expect(within(card).getByText("Days without a nonzero performance observation")).toBeTruthy();
    expect(within(card).queryByText(/confidence/i)).toBeNull();
  });

  it("renders truthful unavailable fit-time evidence", () => {
    statusUseQuery.mockReturnValue({
      data: mockData,
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    const card = screen.getByRole("article", {
      name: "Readiness Score Weights model evidence",
    });
    expect(
      within(card).getByText("Successful fit time unavailable until this model is refit"),
    ).toBeTruthy();
  });
});
