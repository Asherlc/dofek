import type { Meta, StoryObj } from "@storybook/react-native";
import { WhoopAuthModal } from "./providers";

const meta = {
  title: "Providers/WhoopAuthModal",
  component: WhoopAuthModal,
  args: {
    onClose: () => {},
    onSuccess: () => {},
  },
} satisfies Meta<typeof WhoopAuthModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
