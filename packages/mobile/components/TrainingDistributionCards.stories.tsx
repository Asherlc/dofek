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
        "The Treff three-zone polarization index describes cycling training only. An index above 2.00 is polarized.",
      weeks: [
        {
          week: "2026-07-20",
          z1Seconds: 4800,
          z2Seconds: 600,
          z3Seconds: 600,
          polarizationIndex: 2.123,
          totalSeconds: 6000,
          zonePercentages: { z1: 80, z2: 10, z3: 10 },
          status: "polarized",
          statusLabel: "Polarized",
          explanation:
            "This cycling week is polarized: it has a Treff polarization index above 2.00.",
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
          z1Seconds: 3600,
          z2Seconds: 0,
          z3Seconds: 600,
          polarizationIndex: null,
          totalSeconds: 4200,
          zonePercentages: { z1: 85.7, z2: 0, z3: 14.3 },
          status: "insufficient_data",
          statusLabel: "Insufficient data",
          explanation:
            "Polarization needs recorded cycling time in all three Treff heart-rate zones.",
        },
      ],
    },
  },
};
