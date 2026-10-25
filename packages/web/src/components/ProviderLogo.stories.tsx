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

export const AppleWatchViaAppleHealth: Story = {
  args: { provider: "apple_health", sourceName: "Asher’s Apple\u00a0Watch" },
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

export const RoundedCorners: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {["#16251b", "#e2e8f0"].map((backgroundColor) => (
        <div
          key={backgroundColor}
          className="flex items-center gap-6 p-6"
          style={{ backgroundColor }}
        >
          {[20, 32, 64].map((size) => (
            <div key={size} className="flex items-center gap-4">
              <ProviderLogo provider="hang-ten" size={size} />
              <ProviderLogo provider="apple_health" sourceName="Hang Ten" size={size} />
              <ProviderLogo provider="apple_health" size={size} />
              <ProviderLogo provider="strava" size={size} />
              <ProviderLogo provider="unknown-provider" size={size} />
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
};
