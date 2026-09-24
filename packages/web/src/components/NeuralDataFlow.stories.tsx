import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { NeuralDataFlow } from "./NeuralDataFlow.tsx";

const meta = {
  title: "Components/NeuralDataFlow",
  component: NeuralDataFlow,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-full bg-page">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NeuralDataFlow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("img", {
        name: /health sources flow into Dofek and insights flow out/i,
      }),
    ).toBeVisible();
    await expect(canvas.getByText("Sleep")).toBeVisible();
    await expect(canvas.getByText("Trends")).toBeVisible();
  },
};
