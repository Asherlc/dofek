import type { Meta, StoryObj } from "@storybook/react-native";
import { ProviderLogo } from "./ProviderLogo";

const meta = {
  title: "Brand/ProviderLogo",
  component: ProviderLogo,
  args: {
    provider: "strava",
    serverUrl: "https://example.com",
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

export const StrongViaAppleHealth: Story = {
  args: { provider: "apple_health", sourceName: "Strong" },
};
export const HangTenViaAppleHealth: Story = {
  args: { provider: "apple_health", sourceName: "Hang Ten" },
};
export const UnknownViaAppleHealth: Story = {
  args: { provider: "apple_health", sourceName: "New App" },
};

export const StravaViaAppleHealth: Story = {
  args: { provider: "apple_health", sourceName: "Strava" },
};

export const GarminWatch: Story = {
  args: { provider: "garmin", sourceName: "Forerunner 965" },
};

export const GarminBikeComputer: Story = {
  args: { provider: "garmin", sourceName: "Edge 1050" },
};

export const GarminFenix8: Story = {
  args: { provider: "garmin", sourceName: "fēnix 8 – 47mm" },
};

export const GarminUnknownModel: Story = {
  args: { provider: "garmin", sourceName: "Unrecognized watch" },
};
