import type { Meta, StoryObj } from "@storybook/react-native";
import { ProviderLogo } from "./ProviderLogo";

const meta = {
  title: "Brand/ProviderLogo",
  component: ProviderLogo,
  args: {
    provider: "strava",
    serverUrl: "https://dofek.asherlc.com",
    size: 32,
  },
} satisfies Meta<typeof ProviderLogo>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Strava: Story = {
  args: {
    provider: "strava",
  },
};

export const AppleHealth: Story = {
  args: {
    provider: "apple_health",
  },
};

export const Large: Story = {
  args: {
    size: 64,
    provider: "strava",
  },
};

export const Fallback: Story = {
  args: {
    provider: "unknown",
  },
};
