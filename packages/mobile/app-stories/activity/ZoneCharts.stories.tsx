import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { HrZonesChart, PowerZonesChart } from "../../app/activity/ZoneDistributionCharts";

const heartRateZones = [
  { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 180, percent: 5.8 },
  { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 9.7 },
  { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 1200, percent: 38.7 },
  { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900, percent: 29 },
  { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 400, percent: 12.9 },
  { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 120, percent: 3.9 },
];

const powerZones = [
  { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 240, percent: 6.6 },
  { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 1800, percent: 49.8 },
  { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 900, percent: 24.9 },
  { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 420, percent: 11.6 },
  { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 180, percent: 5 },
  { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 60, percent: 1.7 },
  { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 15, percent: 0.4 },
];

function ZoneChartsStory({
  variant,
}: {
  variant:
    | "heart-rate"
    | "power"
    | "heart-rate-empty"
    | "power-empty"
    | "heart-rate-loading"
    | "heart-rate-error";
}) {
  const emptyHeartRateZones = heartRateZones.map((zone) => ({ ...zone, seconds: 0, percent: 0 }));
  const emptyPowerZones = powerZones.map((zone) => ({ ...zone, seconds: 0, percent: 0 }));

  return (
    <View style={{ gap: 16 }}>
      {variant === "heart-rate" && <HrZonesChart zones={heartRateZones} />}
      {variant === "power" && <PowerZonesChart zones={powerZones} />}
      {variant === "heart-rate-empty" && <HrZonesChart zones={emptyHeartRateZones} />}
      {variant === "power-empty" && <PowerZonesChart zones={emptyPowerZones} />}
      {variant === "heart-rate-loading" && <HrZonesChart zones={emptyHeartRateZones} loading />}
      {variant === "heart-rate-error" && (
        <HrZonesChart zones={emptyHeartRateZones} errorMessage="Unable to load heart rate zones" />
      )}
    </View>
  );
}

const meta = {
  title: "Pages/ActivityDetail/ZoneCharts",
  component: ZoneChartsStory,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <View style={{ flex: 1, minHeight: 932, padding: 16, backgroundColor: "#000" }}>
        <Story />
      </View>
    ),
  ],
  args: {
    variant: "heart-rate",
  },
} satisfies Meta<typeof ZoneChartsStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const HeartRateZones: Story = {};

export const PowerZones: Story = {
  args: {
    variant: "power",
  },
};

export const EmptyHeartRateZones: Story = {
  args: {
    variant: "heart-rate-empty",
  },
};

export const EmptyPowerZones: Story = {
  args: {
    variant: "power-empty",
  },
};

export const HeartRateZonesLoading: Story = {
  args: {
    variant: "heart-rate-loading",
  },
};

export const HeartRateZonesError: Story = {
  args: {
    variant: "heart-rate-error",
  },
};
