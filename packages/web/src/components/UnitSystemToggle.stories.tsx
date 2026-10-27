import type { UnitSystem } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { UnitContext } from "../lib/unitContext.ts";
import { UnitSystemToggle } from "./UnitSystemToggle.tsx";

function UnitSystemStory({ initialValue }: { initialValue: UnitSystem }) {
  const [unitSystem, setUnitSystem] = useState(initialValue);
  return (
    <UnitContext.Provider value={{ unitSystem, setUnitSystem }}>
      <div className="w-[420px] p-4">
        <UnitSystemToggle />
      </div>
    </UnitContext.Provider>
  );
}

const meta = {
  title: "Settings/UnitSystemToggle",
  component: UnitSystemToggle,
} satisfies Meta<typeof UnitSystemToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Metric: Story = {
  render: () => <UnitSystemStory initialValue="metric" />,
};

export const Imperial: Story = {
  render: () => <UnitSystemStory initialValue="imperial" />,
};
