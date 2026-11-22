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
        "A descriptive view of endurance training time across the Karvonen five-zone heart-rate model.",
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
          "Dofek uses profile maximum heart rate as a proxy for intensity. The easy zone is below 80%, the middle zone is 80–<90%, and the high zone is at least 90% of that value.",
        calculationChoice:
          "Treff defines zero when there is coverage and no high-zone time. With zero middle-zone time, the high-zone share must exceed 1% for the adjustment.",
        interpretation:
          "The >2.00 comparison is Treff's descriptive training-distribution heuristic.",
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
            "This week's recorded cycling distribution is at or below Treff's descriptive 2.00 heuristic.",
        },
      ],
    },
  },
} satisfies Meta<typeof TrainingDistributionCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const InsufficientPolarizationData: Story = {
  args: {
    polarization: {
      ...meta.args.polarization,
      weeks: [
        {
          week: "2026-07-20",
          z1Seconds: 4158,
          z2Seconds: 0,
          z3Seconds: 42,
          polarizationIndex: null,
          totalSeconds: 4200,
          zonePercentages: { z1: 99, z2: 0, z3: 1 },
          status: "insufficient_data",
          statusLabel: "Not calculated",
          explanation:
            "With zero middle-zone time, Treff’s adjustment requires more than 1% high-zone time.",
        },
      ],
    },
  },
};
