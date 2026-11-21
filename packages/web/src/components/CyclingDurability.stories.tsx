import type { Meta, StoryObj } from "@storybook/react-vite";
import { CyclingDurabilityPanel } from "./CyclingDurability.tsx";
import {
  cyclingDurabilityDifferentWeights,
  cyclingDurabilityExample,
  cyclingDurabilityNoLateEffort,
} from "./cycling-durability-fixtures.ts";

const meta = {
  title: "Training/CyclingDurability",
  component: CyclingDurabilityPanel,
  args: { selection: cyclingDurabilityExample.selection, onChange: () => {} },
} satisfies Meta<typeof CyclingDurabilityPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = { args: { data: cyclingDurabilityExample } };
export const DifferentWeights: Story = { args: { data: cyclingDurabilityDifferentWeights } };
export const Loading: Story = { args: { loading: true } };
export const NoEffortAfterWork: Story = { args: { data: cyclingDurabilityNoLateEffort } };
