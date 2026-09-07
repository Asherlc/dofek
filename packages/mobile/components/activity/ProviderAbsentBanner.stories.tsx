import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";

const meta = {
  title: "Activity/ProviderAbsentBanner",
  component: ProviderAbsentBanner,
  args: { activity: { providerId: "strava", providerAbsentAt: "2026-05-27T12:00:00Z" } },
  decorators: [
    (Story) => (
      <View style={{ padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ProviderAbsentBanner>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const UnknownRemovalTime: Story = {
  args: { activity: { providerId: "strava", providerAbsentAt: null } },
};
export const AppleHealthSource: Story = {
  args: {
    activity: {
      providerId: "apple_health",
      subsource: "Strong",
      providerAbsentAt: "2026-05-27T12:00:00Z",
    },
  },
};
