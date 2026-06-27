import type { Meta, StoryObj } from "@storybook/react-vite";
import { CredentialAuthModal } from "./DataSourcesAuthModals.tsx";

const meta = {
  title: "Auth/CredentialAuthModal",
  component: CredentialAuthModal,
  args: {
    providerId: "test-provider",
    providerName: "Test Provider",
    onClose: () => {},
    onSuccess: () => {},
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof CredentialAuthModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDescription: Story = {
  args: {
    description:
      "This provider requires your device serial number. Find it on the back of your device or in the companion app settings.",
  },
};
