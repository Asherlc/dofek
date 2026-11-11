import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import {
  ActivityDetailStoryProviders,
  type RestoreStoryScenario,
} from "./ActivityDetailStoryProviders";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";

const restoreScenarios: RestoreStoryScenario[] = [
  "visible",
  "pending",
  "error",
  "refreshing",
  "refresh-error",
];
function restoreScenario(value: unknown): RestoreStoryScenario {
  return restoreScenarios.find((scenario) => scenario === value) ?? "visible";
}

const meta = {
  title: "Activity/ProviderAbsentBanner",
  component: ProviderAbsentBanner,
  args: {
    activity: {
      id: "00000000-0000-4000-8000-000000000301",
      providerId: "strava",
      providerAbsentAt: "2026-05-27T12:00:00Z",
    },
  },
  decorators: [
    (Story, context) => (
      <ActivityDetailStoryProviders
        restoreScenario={restoreScenario(context.parameters.restoreScenario)}
      >
        <View style={{ padding: 16 }}>
          <Story />
        </View>
      </ActivityDetailStoryProviders>
    ),
  ],
} satisfies Meta<typeof ProviderAbsentBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story = {};
export const Pending: Story = {
  parameters: { restoreScenario: "pending" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByRole("button", { name: "Restoring…" });
  },
};
export const RestoreError: Story = {
  name: "Error",
  parameters: { restoreScenario: "error" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByText("Provider connection is unavailable");
  },
};
export const AppleHealthSource: Story = {
  args: {
    activity: {
      id: "00000000-0000-4000-8000-000000000303",
      providerId: "apple_health",
      subsource: "Strong",
      providerAbsentAt: "2026-05-27T12:00:00Z",
    },
  },
};

export const RefreshingCharts: Story = {
  parameters: { restoreScenario: "refreshing" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByRole("button", { name: "Restoring…" });
  },
};
export const ChartRefreshError: Story = {
  parameters: { restoreScenario: "refresh-error" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Restore activity" }));
    await canvas.findByText(
      "Activity restored, but refreshing charts failed. Use Recompute to retry.",
    );
  },
};
