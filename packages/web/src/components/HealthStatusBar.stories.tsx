import { formatCaloriesMeasurement, formatHRVMeasurement } from "@dofek/format/format";
import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { HealthStatusBar } from "./HealthStatusBar";

const imperialUnits = new UnitConverter("imperial");

const meta = {
  title: "Components/HealthStatusBar",
  component: HealthStatusBar,
  tags: ["autodocs"],
  args: {
    metrics: [
      {
        label: "HRV",
        value: 65,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
} satisfies Meta<typeof HealthStatusBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const Warning: Story = {
  args: {
    metrics: [
      {
        label: "HRV",
        value: 48,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
};

export const Destructive: Story = {
  args: {
    metrics: [
      {
        label: "HRV",
        value: 38,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
};

export const Unknown: Story = {
  args: {
    metrics: [
      {
        label: "HRV",
        value: null,
        avg: 60,
        stddev: 8,
        unit: "ms",
      },
    ],
  },
};

export const FormattedUnits: Story = {
  args: {
    metrics: [
      {
        label: "Heart Rate Variability (HRV)",
        value: 57,
        avg: 51,
        stddev: 8,
        formatValue: formatHRVMeasurement,
      },
      {
        label: "Active Energy",
        value: 302,
        avg: null,
        stddev: null,
        formatValue: formatCaloriesMeasurement,
      },
      {
        label: "Skin Temp",
        value: 34.4,
        avg: 34.1,
        stddev: 0.5,
        formatValue: (value) => imperialUnits.formatTemperature(value),
      },
    ],
  },
};
