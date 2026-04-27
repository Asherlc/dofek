import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ProviderGuide } from "./ProviderGuide";

const providerCatalog = [
  { id: "strava", name: "Strava", authorized: false, importOnly: false, authType: "oauth" },
  { id: "garmin", name: "Garmin", authorized: false, importOnly: false, authType: "custom:garmin" },
  { id: "wahoo", name: "Wahoo", authorized: false, importOnly: false, authType: "oauth" },
  { id: "polar", name: "Polar", authorized: false, importOnly: false, authType: "oauth" },
  { id: "fitbit", name: "Fitbit", authorized: false, importOnly: false, authType: "oauth" },
  { id: "zwift", name: "Zwift", authorized: false, importOnly: false, authType: "oauth" },
  { id: "peloton", name: "Peloton", authorized: false, importOnly: false, authType: "credential" },
  { id: "oura", name: "Oura", authorized: false, importOnly: false, authType: "oauth" },
  { id: "whoop", name: "WHOOP", authorized: false, importOnly: false, authType: "custom:whoop" },
  {
    id: "eight-sleep",
    name: "Eight Sleep",
    authorized: false,
    importOnly: false,
    authType: "credential",
  },
  {
    id: "cronometer-csv",
    name: "Cronometer",
    authorized: false,
    importOnly: true,
    authType: "file-import",
  },
  { id: "fatsecret", name: "FatSecret", authorized: false, importOnly: false, authType: "oauth" },
  { id: "withings", name: "Withings", authorized: false, importOnly: false, authType: "oauth" },
  {
    id: "ultrahuman",
    name: "Ultrahuman",
    authorized: false,
    importOnly: false,
    authType: "credential",
  },
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

export const UsableProvidersOnly: Story = {
  args: {
    providers: [
      { id: "strava", name: "Strava", authorized: false, importOnly: false, authType: "oauth" },
      {
        id: "cronometer-csv",
        name: "Cronometer",
        authorized: false,
        importOnly: true,
        authType: "file-import",
      },
    ],
  },
};

export const NoAvailableProviders: Story = {
  args: {
    providers: [],
  },
};
