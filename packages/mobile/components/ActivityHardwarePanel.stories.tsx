import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import type { Meta, StoryObj } from "@storybook/react-native";
import { ActivityHardwarePanel } from "./ActivityHardwarePanel";
import { recognizedWatches } from "./ActivityHardwarePanel.fixtures";

const data: ActivityHardware = {
  items: [
    {
      id: "edge",
      activityId: "ride",
      providerId: "garmin",
      sourceName: null,
      role: "recorder",
      label: "Edge 530",
      model: "Edge 530",
      manufacturer: "Garmin",
      evidence: "Recording device reported by Garmin.",
      details: [
        { label: "Firmware", value: "9.75" },
        { label: "Serial number", value: "12345678" },
      ],
    },
    {
      id: "hrm",
      activityId: "ride",
      providerId: "garmin",
      sourceName: null,
      role: "sensor",
      label: "HRM-Pro",
      model: "HRM-Pro",
      manufacturer: "Garmin",
      evidence: "Observed in the FIT file; this does not identify the source of every sample.",
      details: [
        { label: "Battery voltage", value: "2.8 V" },
        { label: "Connection", value: "Antplus" },
      ],
    },
  ],
  power: [
    {
      activityId: "strava-ride",
      providerId: "strava",
      kind: "measured",
      label: "Strava reports power-meter data.",
    },
  ],
};
const meta = {
  title: "Activity/ActivityHardwarePanel",
  component: ActivityHardwarePanel,
} satisfies Meta<typeof ActivityHardwarePanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RecognizedWatchModels: Story = { args: { data: recognizedWatches } };
export const RecorderAndSensors: Story = { args: { data } };
export const FitFileCreator: Story = {
  args: {
    data: {
      items: [
        {
          id: "creator",
          activityId: "ride",
          providerId: "fit-file",
          sourceName: null,
          role: "creator",
          label: "Export platform",
          model: null,
          manufacturer: null,
          evidence:
            "FIT file creator; may be an export platform rather than the original recording device.",
          details: [{ label: "Firmware", value: "1.0" }],
        },
      ],
      power: [],
    },
  },
};
export const ReportedApp: Story = {
  args: {
    data: {
      items: [
        {
          id: "source",
          activityId: "ride",
          providerId: "amazfit-zepp",
          sourceName: null,
          role: "source",
          label: "Zepp",
          model: null,
          manufacturer: null,
          evidence: "Reported source or app; original recording hardware is not established.",
          details: [],
        },
      ],
      power: [],
    },
  },
};
export const PartialMetadata: Story = {
  args: {
    data: {
      items: [
        {
          id: "peloton",
          activityId: "ride",
          sourceName: null,
          role: "category",
          label: "bike",
          model: null,
          manufacturer: null,
          providerId: "peloton",
          evidence: "Reported equipment category or platform; exact model unavailable.",
          details: [],
        },
      ],
      power: [],
    },
  },
};
export const PelotonAndStrava: Story = {
  args: {
    data: {
      items: [
        {
          id: "peloton-bike-plus",
          activityId: "peloton-ride",
          providerId: "peloton",
          sourceName: null,
          role: "category",
          label: "Peloton Bike+",
          model: null,
          manufacturer: null,
          evidence: "Reported equipment category or platform; exact model unavailable.",
          details: [{ label: "Platform", value: "Peloton Bike" }],
        },
        {
          id: "strava-bike",
          activityId: "strava-ride",
          providerId: "strava",
          sourceName: "Peloton Bike",
          role: "recorder",
          label: "Peloton Bike",
          model: null,
          manufacturer: null,
          evidence: "Recording device reported by the provider.",
          details: [],
        },
      ],
      power: [
        {
          activityId: "strava-ride",
          providerId: "strava",
          kind: "measured",
          label: "Power · Measured · Strava",
        },
      ],
    },
  },
};
export const LongDeviceFacts: Story = {
  parameters: { layout: "padded" },
  args: {
    data: {
      items: [
        {
          id: "long-device-facts",
          activityId: "ride",
          providerId: "apple_health",
          sourceName: "com.example.workout".repeat(6),
          role: "recorder",
          label: "Workout recorder",
          model: "DeviceModel".repeat(10),
          manufacturer: "ManufacturerName".repeat(8),
          evidence: "Hardware reported by HealthKit.",
          details: [{ label: "Local identifier", value: "0123456789abcdef".repeat(8) }],
        },
      ],
      power: [],
    },
  },
};
export const Empty: Story = { args: { data: { items: [], power: [] } } };
export const Loading: Story = { args: { loading: true } };
export const LoadError: Story = {
  args: { error: new Error("Hardware metadata is unavailable. Retry this activity.") },
};
export const CachedError: Story = {
  args: { data, error: new Error("Refresh failed. Retry this activity.") },
};
