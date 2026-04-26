import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExportPanel } from "./ExportPanel.tsx";

const meta = {
  title: "Components/ExportPanel",
  component: ExportPanel,
} satisfies Meta<typeof ExportPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
