import type { Meta, StoryObj } from "@storybook/react-vite";
import { WhoopSensorDetails } from "./WhoopSensorDetails.tsx";

const meta = {
  title: "Providers/WhoopSensorDetails",
  component: WhoopSensorDetails,
  args: {
    isLoading: false,
    error: null,
    data: {
      latestReceivedAt: "2026-10-30T12:00:00.000Z",
      latestMeasuredAt: "2026-10-30T11:59:00.000Z",
      skinTemperatureC: 32.18,
      records: [
        {
          captureId: "1087b7ac-fc32-4c29-8b31-72e366dc974d",
          deviceId: "strap-a",
          deviceInfo: { name: "WHOOP MG", firmware: "50.42.1.0" },
          receivedAt: "2026-10-30T12:00:00.000Z",
          measuredAt: "2026-10-30T11:59:00.000Z",
          packetType: 47,
          layout: 18,
          skinTemperatureC: 32.18,
          interpretation: "Capture-backed R18 encoding; temperature calibration unverified.",
          rawFrameHex: "aa01740001003fb12f1280",
          fields: [{ label: "Thermal channel A", value: 294, unit: "raw" }],
        },
      ],
    },
  },
} satisfies Meta<typeof WhoopSensorDetails>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Captured: Story = {};
export const Loading: Story = {
  args: { isLoading: true, data: undefined },
};
export const WaitingForUpload: Story = {
  args: {
    data: { latestReceivedAt: null, latestMeasuredAt: null, skinTemperatureC: null, records: [] },
  },
};
export const RefreshError: Story = {
  args: { error: "Sensor records could not be read. Try again." },
};
