import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PersonalizationPanel } from "./PersonalizationPanel";
import { trpc } from "../lib/trpc";

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
      readinessWeights: { hrv: 0.4, restingHr: 0.2, sleep: 0.3, loadBalance: 0.1 },
      sleepTarget: { minutes: 480 },
      stressThresholds: { hrvThresholds: [40, 50, 60] },
      trainingImpulseConstants: { genderFactor: 1.0, exponent: 1.9 },
    },
    defaults: {
      exponentialMovingAverage: { chronicTrainingLoadDays: 42, acuteTrainingLoadDays: 7 },
      readinessWeights: { hrv: 0.3, restingHr: 0.2, sleep: 0.3, loadBalance: 0.2 },
      sleepTarget: { minutes: 480 },
      stressThresholds: { hrvThresholds: [35, 45, 55] },
      trainingImpulseConstants: { genderFactor: 1.0, exponent: 1.9 },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation for mutations to avoid undefined errors
    (trpc.personalization.refit.useMutation as any).mockReturnValue({ mutate: vi.fn(), isPending: false });
    (trpc.personalization.reset.useMutation as any).mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it("renders loading state", () => {
    (trpc.personalization.status.useQuery as any).mockReturnValue({ isLoading: true });
    render(<PersonalizationPanel />);
    // Our mock renders ActivityIndicator as an <activityindicator> tag with progressbar role
    expect(screen.getByRole("progressbar", { hidden: true })).toBeTruthy();
  });

  it("renders personalized status", () => {
    (trpc.personalization.status.useQuery as any).mockReturnValue({ data: mockData, isLoading: false });
    render(<PersonalizationPanel />);
    expect(screen.getByText("Personalized")).toBeTruthy();
    expect(screen.getByText(/Updated/)).toBeTruthy();
  });

  it("renders parameter cards with learned data", () => {
    (trpc.personalization.status.useQuery as any).mockReturnValue({ data: mockData, isLoading: false });
    render(<PersonalizationPanel />);
    
    expect(screen.getByText("Training Load Windows")).toBeTruthy();
    // Use getAllByText because it appears both in Value and in Default value footer
    expect(screen.getAllByText(/Fitness: 42d, Fatigue: 7d/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Learned").length).toBeGreaterThan(0);
  });

  it("shows refit button and handles click", () => {
    const mutate = vi.fn();
    (trpc.personalization.status.useQuery as any).mockReturnValue({ data: mockData, isLoading: false });
    (trpc.personalization.refit.useMutation as any).mockReturnValue({ mutate, isPending: false });
    
    render(<PersonalizationPanel />);
    const refitButton = screen.getByText("Refit Now");
    // In our test-setup TouchableOpacity/Pressable are rendered as <button>
    fireEvent.click(refitButton);
    expect(mutate).toHaveBeenCalled();
  });

  it("shows reset button when personalized", () => {
    (trpc.personalization.status.useQuery as any).mockReturnValue({ 
      data: { ...mockData, isPersonalized: true },
      isLoading: false
    });
    
    render(<PersonalizationPanel />);
    expect(screen.getByText("Reset to Defaults")).toBeTruthy();
  });

  it("hides reset button when not personalized", () => {
    (trpc.personalization.status.useQuery as any).mockReturnValue({ 
      data: { ...mockData, isPersonalized: false },
      isLoading: false
    });
    
    render(<PersonalizationPanel />);
    expect(screen.queryByText("Reset to Defaults")).toBeNull();
  });
});
