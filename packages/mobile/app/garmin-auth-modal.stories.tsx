import type { Meta, StoryObj } from "@storybook/react-native";
import { GarminAuthModal } from "./providers";

const meta = {
  title: "Providers/GarminAuthModal",
  component: GarminAuthModal,
  args: {
    onClose: () => {},
    onSuccess: () => {},
  },
} satisfies Meta<typeof GarminAuthModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
