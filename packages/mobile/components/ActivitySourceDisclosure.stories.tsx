import type { Meta, StoryObj } from "@storybook/react-native";
import { Text, View } from "react-native";
import { expect, within } from "storybook/test";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure";

const meta = {
  title: "Activities/ActivitySourceDisclosure",
  component: ActivitySourceDisclosure,
  args: {
    origin: {
      status: "resolved",
      memberActivityId: "00000000-0000-4000-8000-000000000001",
      providerId: "whoop",
      sourceName: null,
    },
  },
  decorators: [
    (Story) => (
      <View style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 4 }}>
        <Text>8:15 AM · 45m</Text>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivitySourceDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DirectWhoop: Story = {};
export const HangTenViaAppleHealth: Story = {
  args: {
    origin: { ...meta.args.origin, providerId: "apple_health", sourceName: "Hang Ten Training" },
  },
};
export const UnknownRecordingApp: Story = {
  args: {
    origin: { ...meta.args.origin, providerId: "apple_health", sourceName: "My Workout App" },
  },
};
export const UnresolvedOrigin: Story = {
  args: { origin: { status: "unresolved", candidateMemberActivityIds: [] } },
};
export const SourceDetailsOpen: Story = {
  ...HangTenViaAppleHealth,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Activity source: Hang Ten" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Recorded in")).toBeVisible();
    await expect(await page.findByText("Imported via")).toBeVisible();
  },
};
