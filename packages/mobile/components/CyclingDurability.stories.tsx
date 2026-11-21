import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { CyclingDurabilityPanel } from "./CyclingDurability";
import { cyclingDurabilityExample } from "./cycling-durability-fixtures";

const metricUnits = new UnitConverter("metric");

function Preview(args: Omit<ComponentProps<typeof CyclingDurabilityPanel>, "units">) {
  return <CyclingDurabilityPanel {...args} units={metricUnits} />;
}

const meta = {
  title: "Training/CyclingDurability",
  component: Preview,
  args: { selection: cyclingDurabilityExample.selection, onChange: () => {} },
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 390 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof Preview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = { args: { data: cyclingDurabilityExample } };
export const Loading: Story = { args: { loading: true } };
export const NoEffortAfterWork: Story = {
  args: {
    data: {
      ...cyclingDurabilityExample,
      status: "no_effort_after_work",
      afterWork: null,
      presentation: { ...cyclingDurabilityExample.presentation, difference: 0 },
    },
  },
};
