import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProviderLogo } from "./ProviderLogo";

const meta = {
  title: "Brand/ProviderLogo",
  component: ProviderLogo,
  tags: ["autodocs"],
  args: {
    provider: "strava",
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

export const RideWithGPS: Story = {
  args: {
    provider: "ride-with-gps",
  },
};

export const Whoop: Story = {
  args: {
    provider: "whoop",
  },
};

export const CustomFallback: Story = {
  args: {
    provider: "unknown-provider",
  },
};

export const Large: Story = {
  args: {
    size: 64,
    provider: "strava",
  },
};
