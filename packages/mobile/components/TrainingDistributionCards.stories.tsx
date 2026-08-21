import type { Meta, StoryObj } from "@storybook/react-native";
import { TrainingDistributionCards } from "./TrainingDistributionCards";

const meta = {
  title: "Components/TrainingDistributionCards",
  component: TrainingDistributionCards,
  args: {
    intensityDistribution: {
      model: "karvonen-five-zone",
      activityScope: "endurance",
      totalSeconds: 7200,
      zones: [
        { zone: 0, label: "Below Zone 1", seconds: 300, percent: 4.2 },
        { zone: 1, label: "Recovery", seconds: 1800, percent: 25 },
        { zone: 2, label: "Aerobic", seconds: 3600, percent: 50 },
        { zone: 3, label: "Tempo", seconds: 900, percent: 12.5 },
        { zone: 4, label: "Threshold", seconds: 450, percent: 6.3 },
        { zone: 5, label: "VO2max", seconds: 150, percent: 2.1 },
      ],
      explanation:
        "A descriptive view of endurance training time across the Karvonen five-zone heart-rate model. It does not classify training polarization.",
    },
    polarization: {
      model: "treff-three-zone",
      activityScope: "cycling",
      threshold: 2,
      maxHr: 190,
      explanation:
        "The Treff three-zone polarization index is a descriptive summary of recorded cycling training.",
      method: {
        formula:
          "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
        zoneBasis:
          "Easy zone (Zone 1) is below 80%, threshold zone (Zone 2) is 80–<90%, and high zone (Zone 3) is at least 90% of maximum heart rate.",
        calculationChoice:
          "Dofek requires recorded time in all three zones and does not calculate the polarization index when high-zone time exceeds easy-zone time.",
        interpretation:
          "The >2.00 comparison is Treff's descriptive training-distribution heuristic, not a physiological or medical assessment.",
        source: {
          title: "Treff et al. (2019), The Polarization-Index",
          url: "https://doi.org/10.3389/fphys.2019.00707",
        },
      },
      weeks: [
        {
          week: "2026-07-20",
          z1Seconds: 4800,
          z2Seconds: 600,
          z3Seconds: 600,
          polarizationIndex: 1.903,
          totalSeconds: 6000,
          zonePercentages: { z1: 80, z2: 10, z3: 10 },
          status: "not_polarized",
          statusLabel: "Does not match polarized-pattern heuristic",
          explanation:
            "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
        },
      ],
    },
    monotony: [
      {
        week: "2026-07-20",
        monotony: 1.5,
        strain: 300,
        weeklyLoad: 200,
        dailyMeanLoad: 28.57,
        dailyLoadStandardDeviation: 19.05,
        method: {
          formula:
            "Monotony = 7-day mean daily cycling load ÷ population standard deviation of daily cycling load. Strain = weekly cycling load × monotony.",
          calendar: "Monday–Sunday calendar weeks include zero-load days.",
          activityScope: "Cycling activities with computed endurance training load.",
          interpretation:
            "These are descriptive workload-variability summaries, not an overtraining diagnosis.",
          source: {
            title: "Foster (1998), Monitoring training in athletes",
            url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
          },
        },
      },
    ],
  },
} satisfies Meta<typeof TrainingDistributionCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const EmptyMonotonyData: Story = {
  args: {
    monotony: [],
  },
};

export const InsufficientPolarizationData: Story = {
  args: {
    polarization: {
      ...meta.args.polarization,
      weeks: [
        {
          week: "2026-07-20",
          z1Seconds: 3600,
          z2Seconds: 0,
          z3Seconds: 600,
          polarizationIndex: null,
          totalSeconds: 4200,
          zonePercentages: { z1: 85.7, z2: 0, z3: 14.3 },
          status: "insufficient_data",
          statusLabel: "Not calculated",
          explanation:
            "The index is not calculated because Dofek requires recorded cycling time in all three Treff heart-rate zones.",
        },
      ],
    },
  },
};
