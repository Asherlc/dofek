import type { Meta, StoryObj } from "@storybook/react-vite";
import { UnitContext } from "../lib/unitContext.ts";
import { BodyDecisionContext } from "./BodyDecisionContext.tsx";

const meta = {
  title: "Body/BodyDecisionContext",
  component: BodyDecisionContext,
  decorators: [
    (Story) => (
      <UnitContext value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
        <div className="max-w-xl rounded-lg border border-border-subtle bg-surface-solid p-4">
          <Story />
        </div>
      </UnitContext>
    ),
  ],
} satisfies Meta<typeof BodyDecisionContext>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = {
  args: {
    context: {
      latestMeasurement: {
        recordedAtLocal: "2026-07-25 08:00:00",
        weightKg: 80,
        providerId: "withings",
        sourceName: "Body+",
      },
      variation: {
        status: "available",
        observations: 12,
        minimumObservations: 8,
        maximumObservations: 30,
        lowerResidualKg: -0.4,
        upperResidualKg: 0.6,
      },
    },
  },
};

export const InsufficientData: Story = {
  args: {
    context: {
      latestMeasurement: null,
      variation: {
        status: "insufficient_data",
        observations: 4,
        minimumObservations: 8,
        maximumObservations: 30,
        lowerResidualKg: null,
        upperResidualKg: null,
      },
    },
  },
};

export const Unavailable: Story = {
  args: {
    context: null,
  },
};
