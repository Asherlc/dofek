import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { HrZonesChart, PowerZonesChart } from "./[id]";

const heartRateZones = [
  { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300 },
  { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 1200 },
  { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900 },
  { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 400 },
  { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 120 },
];

const powerZones = [
  { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 240 },
  { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 1800 },
  { zone: 3, label: "Tempo", minPct: 75, maxPct: 90, seconds: 900 },
  { zone: 4, label: "Threshold", minPct: 90, maxPct: 105, seconds: 420 },
  { zone: 5, label: "VO2max", minPct: 105, maxPct: 120, seconds: 180 },
  { zone: 6, label: "Anaerobic", minPct: 120, maxPct: 150, seconds: 60 },
  { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 15 },
];

function ZoneChartsStory({
  variant,
}: {
  variant: "heart-rate" | "power" | "heart-rate-empty" | "power-empty";
}) {
  const emptyHeartRateZones = heartRateZones.map((zone) => ({ ...zone, seconds: 0 }));
  const emptyPowerZones = powerZones.map((zone) => ({ ...zone, seconds: 0 }));

  return (
    <View style={{ gap: 16 }}>
      {variant === "heart-rate" && <HrZonesChart zones={heartRateZones} />}
      {variant === "power" && <PowerZonesChart zones={powerZones} />}
      {variant === "heart-rate-empty" && <HrZonesChart zones={emptyHeartRateZones} />}
      {variant === "power-empty" && <PowerZonesChart zones={emptyPowerZones} />}
    </View>
  );
}

const meta = {
  title: "Pages/ActivityDetail/ZoneCharts",
  component: ZoneChartsStory,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: "#000", width: 380 }}>
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
