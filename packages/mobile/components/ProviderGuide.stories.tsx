import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ProviderGuide } from "./ProviderGuide";

const providerCatalog = [
  { id: "strava", name: "Strava", authorized: false },
  { id: "garmin", name: "Garmin", authorized: false },
  { id: "wahoo", name: "Wahoo", authorized: false },
  { id: "polar", name: "Polar", authorized: false },
  { id: "fitbit", name: "Fitbit", authorized: false },
  { id: "zwift", name: "Zwift", authorized: false },
  { id: "peloton", name: "Peloton", authorized: false },
  { id: "oura", name: "Oura", authorized: false },
  { id: "whoop", name: "WHOOP", authorized: false },
  { id: "eight-sleep", name: "Eight Sleep", authorized: false },
  { id: "cronometer-csv", name: "Cronometer", authorized: false },
  { id: "fatsecret", name: "FatSecret", authorized: false },
  { id: "withings", name: "Withings", authorized: false },
  { id: "ultrahuman", name: "Ultrahuman", authorized: false },
];

const meta = {
  title: "Providers/ProviderGuide",
  component: ProviderGuide,
  args: {
    providers: providerCatalog,
    onDismiss: () => {},
  },
  decorators: [
    (Story) => (
      <View style={{ width: 390, padding: 16 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ProviderGuide>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LimitedProviders: Story = {
  args: {
    providers: providerCatalog.filter((provider) =>
      ["strava", "garmin", "oura", "whoop", "withings"].includes(provider.id),
    ),
  },
};

export const NoAvailableProviders: Story = {
  args: {
    providers: [],
  },
};
