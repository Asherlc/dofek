// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockMonotonyData: unknown[] = [];
let mockPolarizationData: { weeks: unknown[] } | undefined;
let mockRampData: { currentRampRate: number | null } | undefined;
let mockMuscleGroupData: unknown[] = [];
let mockVolumeData: unknown[] = [];
let mockOneRepMaxData: unknown[] = [];
let mockOverloadData: unknown[] = [];
let mockAerobicEfficiencyData: { activities: unknown[] } | undefined;
let mockVerticalAscentData: unknown[] = [];
let mockActivityVariabilityData: { rows: unknown[] } | undefined;
let mockPaceCurveData: { points: unknown[] } | undefined;

function q(getData: () => unknown = () => undefined) {
  return { useQuery: () => ({ data: getData(), isLoading: false }) };
}

vi.mock("../lib/trpc", () => ({
  trpc: {
    pmc: {
      chart: q(() => ({ data: [], model: null })),
    },
    calendar: {
      calendarData: q(() => []),
    },
    efficiency: {
      polarizationTrend: {
        useQuery: () => ({ data: mockPolarizationData, isLoading: false }),
      },
      aerobicEfficiency: {
        useQuery: () => ({ data: mockAerobicEfficiencyData, isLoading: false }),
      },
    },
    cyclingAdvanced: {
      rampRate: {
        useQuery: () => ({ data: mockRampData, isLoading: false }),
      },
      trainingMonotony: {
        useQuery: () => ({ data: mockMonotonyData, isLoading: false }),
      },
      verticalAscentRate: {
        useQuery: () => ({ data: mockVerticalAscentData, isLoading: false }),
      },
      activityVariability: {
        useQuery: () => ({ data: mockActivityVariabilityData, isLoading: false }),
      },
    },
    power: {
      eftpTrend: q(() => ({ trend: [], currentEftp: null })),
      powerCurve: q(() => ({ model: null, points: [] })),
    },
    running: {
      paceTrend: q(() => []),
      dynamics: q(() => []),
    },
    durationCurves: {
      paceCurve: {
        useQuery: () => ({ data: mockPaceCurveData, isLoading: false }),
      },
    },
    strength: {
      volumeOverTime: {
        useQuery: () => ({ data: mockVolumeData, isLoading: false }),
      },
      estimatedOneRepMax: {
        useQuery: () => ({ data: mockOneRepMaxData, isLoading: false }),
      },
      progressiveOverload: {
        useQuery: () => ({ data: mockOverloadData, isLoading: false }),
      },
      muscleGroupVolume: {
        useQuery: () => ({ data: mockMuscleGroupData, isLoading: false }),
      },
    },
    hiking: {
      gradeAdjustedPace: q(() => []),
      elevationProfile: q(() => []),
    },
    recovery: {
      readinessScore: q(() => []),
      workloadRatio: q(() => []),
      hrvVariability: q(() => []),
    },
  },
}));

vi.mock("../lib/units", async () => {
  const actual = await vi.importActual<typeof import("../lib/units")>("../lib/units");
  return {
    ...actual,
    useUnitSystem: () => "metric" as const,
  };
});

vi.mock("../theme", () => ({
  colors: {
    background: "#000",
    surface: "#1a1a1a",
    surfaceSecondary: "#2a2a2a",
    accent: "#0af",
    text: "#fff",
    textSecondary: "#999",
    textTertiary: "#666",
    danger: "#f00",
    positive: "#0f0",
    warning: "#ff0",
    teal: "#0ff",
    purple: "#a0f",
    blue: "#00f",
    green: "#0f0",
    orange: "#f80",
  },
  statusColors: {
    positive: "#0f0",
    warning: "#ff0",
    danger: "#f00",
    info: "#0af",
  },
}));

async function renderTrainingScreen() {
  const { default: TrainingScreen } = await import("./training");
  return render(<TrainingScreen />);
}

function clickTab(label: string) {
  const button = screen.getByText(label);
  fireEvent.click(button);
}

describe("TrainingScreen — EnduranceTab", () => {
  beforeEach(() => {
    mockMonotonyData = [];
    mockPolarizationData = undefined;
    mockRampData = undefined;
    mockMuscleGroupData = [];
    mockVolumeData = [];
    mockOneRepMaxData = [];
    mockOverloadData = [];
    mockAerobicEfficiencyData = undefined;
    mockVerticalAscentData = [];
    mockActivityVariabilityData = undefined;
    mockPaceCurveData = undefined;
  });

  it("renders Training Monotony & Strain card when monotony data exists", async () => {
    mockMonotonyData = [
      { week: "2024-01", monotony: 1.2, strain: 450 },
      { week: "2024-02", monotony: 1.8, strain: 520 },
    ];
    mockPolarizationData = { weeks: [] };
    mockRampData = { currentRampRate: null };

    await renderTrainingScreen();
    clickTab("Endurance");

    expect(screen.getByText("Training Monotony & Strain")).toBeTruthy();
    expect(screen.getByText("Monotony")).toBeTruthy();
    expect(screen.getByText("Strain")).toBeTruthy();
    expect(screen.getByText("1.80")).toBeTruthy();
    expect(screen.getByText("520")).toBeTruthy();
  });

  it("does NOT show empty state when monotony data exists but polarization and ramp are empty", async () => {
    mockMonotonyData = [{ week: "2024-01", monotony: 1.2, strain: 300 }];
    mockPolarizationData = { weeks: [] };
    mockRampData = { currentRampRate: null };

    await renderTrainingScreen();
    clickTab("Endurance");

    expect(screen.queryByText("No endurance data available for this period.")).toBeNull();
  });

  it("shows empty state when ALL sources are empty (polarization, ramp, and monotony)", async () => {
    mockMonotonyData = [];
    mockPolarizationData = { weeks: [] };
    mockRampData = { currentRampRate: null };

    await renderTrainingScreen();
    clickTab("Endurance");

    expect(screen.getByText("No endurance data available for this period.")).toBeTruthy();
  });
});

describe("TrainingScreen — CyclingTab", () => {
  beforeEach(() => {
    mockMonotonyData = [];
    mockPolarizationData = undefined;
    mockRampData = undefined;
    mockMuscleGroupData = [];
    mockVolumeData = [];
    mockOneRepMaxData = [];
    mockOverloadData = [];
    mockAerobicEfficiencyData = undefined;
    mockVerticalAscentData = [];
    mockActivityVariabilityData = undefined;
    mockPaceCurveData = undefined;
  });

  it("renders ActivityVariabilitySection with expanded column headers", async () => {
    mockActivityVariabilityData = {
      rows: [
        {
          date: "2024-01-15",
          activityName: "Morning Ride",
          normalizedPower: 220,
          variabilityIndex: 1.05,
          intensityFactor: 0.82,
        },
      ],
    };

    await renderTrainingScreen();
    clickTab("Cycling");

    expect(screen.getByText("Norm. Power")).toBeTruthy();
    expect(screen.getByText("Var. Index")).toBeTruthy();
    expect(screen.getByText("Int. Factor")).toBeTruthy();
    expect(screen.getByText("Morning Ride")).toBeTruthy();
    expect(screen.getByText("220")).toBeTruthy();
    expect(screen.getByText("1.05")).toBeTruthy();
    expect(screen.getByText("0.82")).toBeTruthy();
  });

  it("renders AerobicEfficiencySection when data exists", async () => {
    mockAerobicEfficiencyData = {
      activities: [
        {
          date: "2024-01-10",
          name: "Zone 2 Ride",
          efficiencyFactor: 1.85,
        },
        {
          date: "2024-01-15",
          name: "Endurance Ride",
          efficiencyFactor: 1.92,
        },
      ],
    };

    await renderTrainingScreen();
    clickTab("Cycling");

    expect(screen.getByText("Aerobic Efficiency")).toBeTruthy();
    expect(screen.getByText("1.92")).toBeTruthy();
    expect(screen.getByText("Endurance Ride — 2024-01-15")).toBeTruthy();
  });

  it("renders VerticalAscentSection when data exists", async () => {
    mockVerticalAscentData = [
      {
        date: "2024-01-10",
        activityName: "Mountain Climb",
        verticalAscentRate: 850,
        elevationGainMeters: 700,
        climbingMinutes: 49,
      },
    ];

    await renderTrainingScreen();
    clickTab("Cycling");

    expect(screen.getByText("Vertical Ascent Rate")).toBeTruthy();
    expect(screen.getByText("850 m/hr")).toBeTruthy();
  });
});

describe("TrainingScreen — RunningTab", () => {
  beforeEach(() => {
    mockMonotonyData = [];
    mockPolarizationData = undefined;
    mockRampData = undefined;
    mockMuscleGroupData = [];
    mockVolumeData = [];
    mockOneRepMaxData = [];
    mockOverloadData = [];
    mockAerobicEfficiencyData = undefined;
    mockVerticalAscentData = [];
    mockActivityVariabilityData = undefined;
    mockPaceCurveData = undefined;
  });

  it("renders Pace Bests cards for key durations", async () => {
    mockPaceCurveData = {
      points: [
        { durationSeconds: 300, bestPaceSecondsPerKm: 240 },
        { durationSeconds: 600, bestPaceSecondsPerKm: 255 },
        { durationSeconds: 1800, bestPaceSecondsPerKm: 270 },
        { durationSeconds: 3600, bestPaceSecondsPerKm: 285 },
      ],
    };

    await renderTrainingScreen();
    clickTab("Running");

    expect(screen.getByText("Pace Bests")).toBeTruthy();
    expect(screen.getByText("5 min")).toBeTruthy();
    expect(screen.getByText("10 min")).toBeTruthy();
    expect(screen.getByText("30 min")).toBeTruthy();
    expect(screen.getByText("60 min")).toBeTruthy();
  });
});

describe("TrainingScreen — StrengthTab", () => {
  beforeEach(() => {
    mockMonotonyData = [];
    mockPolarizationData = undefined;
    mockRampData = undefined;
    mockMuscleGroupData = [];
    mockVolumeData = [];
    mockOneRepMaxData = [];
    mockOverloadData = [];
    mockAerobicEfficiencyData = undefined;
    mockVerticalAscentData = [];
    mockActivityVariabilityData = undefined;
    mockPaceCurveData = undefined;
  });

  it("renders Muscle Group Volume card when data exists", async () => {
    mockMuscleGroupData = [
      {
        muscleGroup: "Chest",
        weeklyData: [{ sets: 12 }, { sets: 15 }],
      },
      {
        muscleGroup: "Back",
        weeklyData: [{ sets: 18 }, { sets: 20 }],
      },
    ];

    await renderTrainingScreen();
    clickTab("Strength");

    expect(screen.getByText("Muscle Group Volume")).toBeTruthy();
    expect(screen.getByText("Chest")).toBeTruthy();
    expect(screen.getByText("27 sets")).toBeTruthy();
    expect(screen.getByText("Back")).toBeTruthy();
    expect(screen.getByText("38 sets")).toBeTruthy();
  });

  it("does NOT show empty state when muscleGroup data exists but volume/oneRepMax/overload are empty", async () => {
    mockMuscleGroupData = [
      {
        muscleGroup: "Legs",
        weeklyData: [{ sets: 10 }],
      },
    ];
    mockVolumeData = [];
    mockOneRepMaxData = [];
    mockOverloadData = [];

    await renderTrainingScreen();
    clickTab("Strength");

    expect(screen.queryByText("No strength data available for this period.")).toBeNull();
  });

  it("shows empty state when ALL sources are empty (volume, oneRepMax, overload, and muscleGroup)", async () => {
    mockMuscleGroupData = [];
    mockVolumeData = [];
    mockOneRepMaxData = [];
    mockOverloadData = [];

    await renderTrainingScreen();
    clickTab("Strength");

    expect(screen.getByText("No strength data available for this period.")).toBeTruthy();
  });
});
