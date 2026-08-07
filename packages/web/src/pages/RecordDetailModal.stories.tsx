import type { Meta, StoryObj } from "@storybook/react-vite";
import { RecordDetailModal } from "./RecordDetailModal.tsx";

const record = {
  id: "record-123",
  provider: "garmin",
  started_at: "2026-07-24T07:30:00.000Z",
  average_heart_rate: 146,
  cadence: null,
  raw: {
    activityName: "Morning Run",
    distanceMeters: 8420,
  },
};

const meta = {
  title: "Providers/RecordDetailModal",
  component: RecordDetailModal,
  args: {
    record,
    onClose: () => {},
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RecordDetailModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutRawData: Story = {
  args: {
    record: {
      id: "record-456",
      provider: "manual",
      note: "User-entered measurement",
      raw: null,
    },
  },
};
