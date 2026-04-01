import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageSection } from "./PageSection";

const meta = {
  title: "Layout/PageSection",
  component: PageSection,
  tags: ["autodocs"],
  args: {
    title: "Training Summary",
    subtitle: "Weekly trend and highlights from your recent sessions.",
    children: <div className="text-sm text-dim">This content is rendered in the section body.</div>,
  },
} satisfies Meta<typeof PageSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithCard: Story = {
  args: {
    card: true,
  },
};

export const WithoutCard: Story = {
  args: {
    card: false,
  },
};
