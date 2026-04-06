import type { Meta, StoryObj } from "@storybook/react-vite";
import { DailyOverview } from "./DailyOverview";

const today = new Date().toLocaleDateString("en-CA");

const mockReadiness = [
  {
    date: today,
    readinessScore: 78,
    components: { hrvScore: 82, restingHrScore: 75, sleepScore: 76, respiratoryRateScore: 70 },
    weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
  },
];

const mockWorkloadRatio = {
  displayedStrain: 13.2,
  displayedDate: today,
  timeSeries: [
    {
      date: today,
      dailyLoad: 120,
      strain: 13.2,
      acuteLoad: 95,
      chronicLoad: 80,
      workloadRatio: 1.19,
    },
  ],
};

const mockSleepPerformance = {
  score: 85,
  tier: "Good" as const,
  actualMinutes: 435,
  neededMinutes: 480,
  efficiency: 91,
  recommendedBedtime: "22:15",
  sleepDate: today,
};

const mockStrainTarget = {
  targetStrain: 15,
  currentStrain: 13.2,
  progressPercent: 88,
  zone: "Push" as const,
  explanation: "Recovery is strong (78). Push for a high-strain day to build fitness.",
};

const meta = {
  title: "Dashboard/DailyOverview",
  component: DailyOverview,
  tags: ["autodocs"],
  args: {
    readiness: mockReadiness,
    workloadRatio: mockWorkloadRatio,
    sleepPerformance: mockSleepPerformance,
    strainTarget: mockStrainTarget,
    readinessLoading: false,
    workloadLoading: false,
    sleepLoading: false,
  },
} satisfies Meta<typeof DailyOverview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: {
    readinessLoading: true,
    workloadLoading: true,
    sleepLoading: true,
  },
};

export const NoData: Story = {
  args: {
    readiness: [],
    workloadRatio: { displayedStrain: 0, displayedDate: null, timeSeries: [] },
    sleepPerformance: null,
  },
};

export const HighRecovery: Story = {
  args: {
    readiness: [
      {
        date: today,
        readinessScore: 92,
        components: { hrvScore: 95, restingHrScore: 90, sleepScore: 88, respiratoryRateScore: 94 },
        weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      },
    ],
  },
};

export const LowRecovery: Story = {
  args: {
    readiness: [
      {
        date: today,
        readinessScore: 35,
        components: { hrvScore: 30, restingHrScore: 40, sleepScore: 35, respiratoryRateScore: 45 },
        weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      },
    ],
    workloadRatio: {
      displayedStrain: 5.2,
      displayedDate: today,
      timeSeries: [
        {
          date: today,
          dailyLoad: 30,
          strain: 5.2,
          acuteLoad: 40,
          chronicLoad: 85,
          workloadRatio: 0.47,
        },
      ],
    },
    sleepPerformance: {
      score: 42,
      tier: "Poor" as const,
      actualMinutes: 280,
      neededMinutes: 480,
      efficiency: 72,
      recommendedBedtime: "21:30",
      sleepDate: today,
    },
  },
};
