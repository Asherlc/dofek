import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileImportButton } from "./FileImportButton.tsx";

const meta = {
  title: "Providers/FileImportButton",
  component: FileImportButton,
  tags: ["autodocs"],
  args: {
    onClick: () => {},
  },
} satisfies Meta<typeof FileImportButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
