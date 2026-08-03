import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trpc } from "../lib/trpc";
import { PersonalizationPanel } from "./PersonalizationPanel";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

// Mock TRPC
vi.mock("../lib/trpc", () => ({
  trpc: {
    personalization: {
      status: {
        useQuery: vi.fn(),
      },
      refit: {
        useMutation: vi.fn(),
      },
      reset: {
        useMutation: vi.fn(),
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

describe("PersonalizationPanel", () => {
  const mockData = {
    isPersonalized: true,
    fittedAt: "2026-03-19T12:00:00Z",
    parameters: {
      exponentialMovingAverage: { sampleCount: 100, correlation: 0.85 },
      readinessWeights: { sampleCount: 90, correlation: 0.75 },
      sleepTarget: { sampleCount: 30 },
      stressThresholds: { sampleCount: 60 },
      trainingImpulseConstants: { sampleCount: 50, r2: 0.9 },
    },
    effective: {
      exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
      readinessWeights: { hrv: 0.4, restingHr: 0.2, sleep: 0.3, respiratoryRate: 0.1 },
      sleepTarget: { minutes: 480 },
      stressThresholds: {
        hrvThresholds: [-2, -1.25, -0.5],
        rhrThresholds: [2, 1.25, 0.5],
      },
      trainingImpulseConstants: { genderFactor: 1.0, exponent: 1.9 },
    },
    defaults: {
      exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
      readinessWeights: { hrv: 0.3, restingHr: 0.2, sleep: 0.3, respiratoryRate: 0.2 },
      sleepTarget: { minutes: 480 },
      stressThresholds: {
        hrvThresholds: [-2, -1.5, -1],
        rhrThresholds: [2, 1.5, 1],
      },
      trainingImpulseConstants: { genderFactor: 1.0, exponent: 1.9 },
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

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation for mutations to avoid undefined errors
    vi.mocked(trpc.personalization.refit.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    vi.mocked(trpc.personalization.reset.useMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
  });

  it("renders loading state", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({ isLoading: true });
    render(<PersonalizationPanel />);
    // Our mock renders ActivityIndicator as an <activityindicator> tag with progressbar role
    expect(screen.getByRole("progressbar", { hidden: true })).toBeTruthy();
  });

  it("surfaces the server error message", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      error: { message: "Personalization history is unavailable" },
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    expect(screen.getByText("Personalization history is unavailable")).toBeTruthy();
  });

  it("reports incomplete model evidence and renders an actionable panel error", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
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

  it("renders personalized status", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: mockData,
      isLoading: false,
    });
    render(<PersonalizationPanel />);
    expect(screen.getByText("Personalized")).toBeTruthy();
    expect(screen.getByText(/Last refit attempt/)).toBeTruthy();
  });

  it("renders parameter cards with learned data", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: mockData,
      isLoading: false,
    });
    render(<PersonalizationPanel />);

    expect(screen.getByText("Training Load Windows")).toBeTruthy();
    // Use getAllByText because it appears both in Value and in Default value footer
    expect(screen.getAllByText(/Fitness: 42d, Fatigue: 7d/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Learned").length).toBeGreaterThan(0);
  });

  it("renders personalized stress thresholds as deviations from baseline", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
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
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: {
        ...mockData,
        isPersonalized: false,
        effective: {
          ...mockData.effective,
          stressThresholds: mockData.defaults.stressThresholds,
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

  it("shows refit button and handles click", () => {
    const mutate = vi.fn();
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: mockData,
      isLoading: false,
    });
    vi.mocked(trpc.personalization.refit.useMutation).mockReturnValue({ mutate, isPending: false });

    render(<PersonalizationPanel />);
    const refitButton = screen.getByText("Refit Now");
    // In our test-setup TouchableOpacity/Pressable are rendered as <button>
    fireEvent.click(refitButton);
    expect(mutate).toHaveBeenCalled();
  });

  it("shows reset button when personalized", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: { ...mockData, isPersonalized: true },
      isLoading: false,
    });

    render(<PersonalizationPanel />);
    expect(screen.getByText("Reset to Defaults")).toBeTruthy();
  });

  it("hides reset button when not personalized", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: { ...mockData, isPersonalized: false },
      isLoading: false,
    });

    render(<PersonalizationPanel />);
    expect(screen.queryByText("Reset to Defaults")).toBeNull();
  });

  it("renders server-built model evidence without deriving confidence", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: mockData,
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    const heading = screen.getByLabelText("Training Load Windows model evidence");
    const card = heading.parentElement?.parentElement;
    if (!card) throw new Error("Training Load Windows card not found");
    expect(within(card).getByText("Past 365 days")).toBeTruthy();
    expect(within(card).getByText("100 qualifying days used; minimum 90 days")).toBeTruthy();
    expect(within(card).getByText("Pearson correlation: 0.850")).toBeTruthy();
    expect(within(card).getByText("No calibrated uncertainty interval is available.")).toBeTruthy();
    expect(within(card).getByText("• Days without a nonzero performance observation")).toBeTruthy();
    expect(card?.textContent).not.toMatch(/confidence/i);
  });

  it("renders truthful unavailable fit-time evidence", () => {
    vi.mocked(trpc.personalization.status.useQuery).mockReturnValue({
      data: mockData,
      isLoading: false,
    });

    render(<PersonalizationPanel />);

    const heading = screen.getByLabelText("Readiness Score Weights model evidence");
    const card = heading.parentElement?.parentElement;
    if (!card) throw new Error("Readiness Score Weights card not found");
    expect(
      within(card).getByText("Successful fit time unavailable until this model is refit"),
    ).toBeTruthy();
  });
});
