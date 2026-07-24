/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { refitUseMutation, resetUseMutation, statusUseQuery } = vi.hoisted(() => ({
  refitUseMutation: vi.fn(),
  resetUseMutation: vi.fn(),
  statusUseQuery: vi.fn(),
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
});
