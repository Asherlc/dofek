import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion.tsx";

const meta = {
  title: "Activity/ActivityPerceivedExertion",
  component: ActivityPerceivedExertion,
  tags: ["autodocs"],
} satisfies Meta<typeof ActivityPerceivedExertion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unset: Story = { args: { value: null } };
export const Logged: Story = { args: { value: 7 } };
