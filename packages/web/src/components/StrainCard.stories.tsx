import type { Meta, StoryObj } from "@storybook/react-vite";
import { StrainCard } from "./StrainCard";

const meta = {
  title: "Recovery/StrainCard",
  component: StrainCard,
  tags: ["autodocs"],
  args: {
    data: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 12.5,
      displayedDate: "2026-03-31",
      timeSeries: [
        {
          date: "2026-03-31",
          dailyLoad: 450,
          strain: 12.5,
          acuteLoad: 380,
          chronicLoad: 400,
          workloadRatio: 0.95,
        },
      ],
    },
    strainTarget: {
      targetStrain: 15.0,
      currentStrain: 12.5,
      progressPercent: 83,
      zone: "Maintain",
      explanation: "Based on the recovery score.",
    },
  },
} satisfies Meta<typeof StrainCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CurrentStrainFromTarget: Story = {
  args: {
    data: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 8.4,
      displayedDate: "2026-03-31",
      timeSeries: [
        {
          date: "2026-03-31",
          dailyLoad: 240,
          strain: 8.4,
          acuteLoad: 310,
          chronicLoad: 390,
          workloadRatio: 0.79,
        },
      ],
    },
    strainTarget: {
      targetStrain: 15.0,
      currentStrain: 12.5,
      progressPercent: 83,
      zone: "Maintain",
      explanation: "Based on the recovery score.",
    },
  },
};

export const FallbackDisplayedStrain: Story = {
  args: {
    data: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 8.4,
      displayedDate: "2026-03-31",
      timeSeries: [
        {
          date: "2026-03-31",
          dailyLoad: 240,
          strain: 8.4,
          acuteLoad: 310,
          chronicLoad: 390,
          workloadRatio: 0.79,
        },
      ],
    },
    strainTarget: undefined,
  },
};

export const TargetMarker: Story = {
  args: {
    strainTarget: {
      targetStrain: 16.5,
      currentStrain: 11.2,
      progressPercent: 68,
      zone: "Push",
      explanation: "Based on the recovery score.",
    },
  },
};

export const HighStrain: Story = {
  args: {
    data: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 18.2,
      displayedDate: "2026-03-31",
      timeSeries: [
        {
          date: "2026-03-31",
          dailyLoad: 800,
          strain: 18.2,
          acuteLoad: 550,
          chronicLoad: 450,
          workloadRatio: 1.22,
        },
      ],
    },
    strainTarget: {
      targetStrain: 16.0,
      currentStrain: 18.2,
      progressPercent: 114,
      zone: "Push",
      explanation: "Based on the recovery score.",
    },
  },
};

export const LowStrain: Story = {
  args: {
    data: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 4.1,
      displayedDate: "2026-03-31",
      timeSeries: [
        {
          date: "2026-03-31",
          dailyLoad: 100,
          strain: 4.1,
          acuteLoad: 250,
          chronicLoad: 300,
          workloadRatio: 0.83,
        },
      ],
    },
    strainTarget: {
      targetStrain: 12.0,
      currentStrain: 4.1,
      progressPercent: 34,
      zone: "Recovery",
      explanation: "Based on the recovery score.",
    },
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
};

export const NoData: Story = {
  args: {
    data: undefined,
    strainTarget: undefined,
  },
};
