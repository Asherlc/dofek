import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { type HeartRateSourceData, MultiSourceHeartRateChart } from "./MultiSourceHeartRateChart";

function generateSamples(
  count: number,
  baseHr: number,
  variance: number,
  startHour: number,
): HeartRateSourceData["samples"] {
  return Array.from({ length: count }, (_, index) => {
    const minutes = startHour * 60 + index;
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const heartRate = Math.round(baseHr + (Math.random() - 0.5) * variance);
    return {
      time: `2026-04-12T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
      heartRate: Math.max(40, Math.min(200, heartRate)),
    };
  });
}

const meta = {
  title: "Charts/MultiSourceHeartRateChart",
  component: MultiSourceHeartRateChart,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: "#f5f7f2" }}>
        <Story />
      </View>
    ),
  ],
  args: {
    sources: [
      {
        providerId: "whoop_ble",
        providerLabel: "WHOOP BLE",
        samples: generateSamples(60, 68, 8, 8),
      },
      {
        providerId: "apple_health",
        providerLabel: "Apple Health",
        samples: generateSamples(60, 72, 6, 8),
      },
    ] satisfies HeartRateSourceData[],
    width: 340,
    height: 200,
  },
} satisfies Meta<typeof MultiSourceHeartRateChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TwoSources: Story = {};

export const ThreeSources: Story = {
  args: {
    sources: [
      {
        providerId: "whoop_ble",
        providerLabel: "WHOOP BLE",
        samples: generateSamples(120, 68, 8, 6),
      },
      {
        providerId: "apple_health",
        providerLabel: "Apple Health",
        samples: generateSamples(90, 72, 6, 7),
      },
      { providerId: "garmin", providerLabel: "Garmin", samples: generateSamples(60, 65, 10, 8) },
    ],
  },
};

export const SingleSource: Story = {
  args: {
    sources: [
      {
        providerId: "whoop_ble",
        providerLabel: "WHOOP BLE",
        samples: generateSamples(120, 68, 8, 6),
      },
    ],
  },
};
