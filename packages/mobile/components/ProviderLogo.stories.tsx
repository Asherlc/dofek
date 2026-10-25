import type { Meta, StoryObj } from "@storybook/react-native";
import { Text, View } from "react-native";
import { ProviderLogo } from "./ProviderLogo";

const meta = {
  title: "Brand/ProviderLogo",
  component: ProviderLogo,
  args: {
    provider: "strava",
    serverUrl: "https://dofek.fit",
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

export const RoundedCornersOnBackgrounds: Story = {
  args: { size: 64 },
  render: (args) => (
    <View style={{ gap: 16 }}>
      {[
        { label: "Dark", backgroundColor: "#16281f", color: "#fff" },
        { label: "Light", backgroundColor: "#f8fafc", color: "#111827" },
        { label: "Colored", backgroundColor: "#643e9a", color: "#fff" },
      ].map(({ label, backgroundColor, color }) => (
        <View key={label} style={{ backgroundColor, padding: 24, gap: 16 }}>
          <Text style={{ color, fontWeight: "600" }}>{label}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 24 }}>
            {[
              { provider: "hang-ten", sourceName: null, label: "Hang Ten" },
              { provider: "wahoo", sourceName: null, label: "Wahoo" },
              { provider: "strava", sourceName: null, label: "Strava" },
              { provider: "apple-watch", sourceName: null, label: "Apple Watch" },
              { provider: "apple_health", sourceName: null, label: "Apple Health" },
              { provider: "apple_health", sourceName: "Hang Ten", label: "Via Apple Health" },
              { provider: "unknown", sourceName: null, label: "Fallback" },
            ].map(({ provider, sourceName, label: providerName }) => (
              <View key={providerName} style={{ alignItems: "center", gap: 8 }}>
                <ProviderLogo {...args} provider={provider} sourceName={sourceName} />
                <Text style={{ color }}>{providerName}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  ),
};
