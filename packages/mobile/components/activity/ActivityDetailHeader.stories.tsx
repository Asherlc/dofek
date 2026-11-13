import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { expect, waitFor, within } from "storybook/test";
import {
  garminActivitySourceHardware,
  garminActivitySourceTree,
  walkingActivitySourceHardware,
  walkingActivitySourceTree,
} from "../../app-fixtures/activity-source-tree";
import { activityImageFixture } from "../activity-images-test-helpers";
import { ActivityDetailHeader } from "./ActivityDetailHeader";
import { detailHeaderActivity, removedDetailHeaderActivity } from "./ActivityDetailHeader.fixtures";
import { ActivityDetailStoryProviders } from "./ActivityDetailStoryProviders";

const meta = {
  title: "Pages/ActivityDetail/ActivityDetailHeader",
  component: ActivityDetailHeader,
  args: { activity: detailHeaderActivity },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: "100%", maxWidth: 560 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActivityDetailHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BranchingSourcesCollapsed: Story = {};
export const FitRecoveryWarning: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      fitRecoveryWarning:
        "Some activity data could not be recovered from the original file. The available data was imported; this activity may be incomplete.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByRole("alert")).toBeVisible();
  },
};
export const BranchingSourcesExpanded: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const trigger = await canvas.findByRole("button", { name: "Lineage: Garmin Edge 530" });
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getAllByText("Garmin Edge 530")).toHaveLength(2);
    await expect(canvas.getAllByText("Apple Health")).toHaveLength(2);
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};
export const UnresolvedSources: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      sourceTree: { primary: null, otherSources: garminActivitySourceTree.otherSources },
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage" }));
    await expect(canvas.getByText("WHOOP")).toBeVisible();
  },
};
export const EmptyTree: Story = {
  args: {
    activity: { ...detailHeaderActivity, sourceTree: { primary: null, otherSources: [] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Morning Ride")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Lineage/ })).toBeNull();
  },
};
export const RemovedSource: Story = {
  args: { activity: removedDetailHeaderActivity },
  decorators: [(Story) => <ActivityDetailStoryProviders>{Story()}</ActivityDetailStoryProviders>],
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage: Garmin Edge 530" }));
    await expect(canvas.getByText("Removed from provider sync on March 5, 2026")).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "View activity for Garmin Edge 530" }),
    ).toBeNull();
  },
};

export const RecordingDeviceCollapsed: Story = {
  args: { hardware: garminActivitySourceHardware },
};

export const ConnectedKilterGymSession: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: "Gym session",
      activityType: "climbing",
      displayedDate: "2026-11-09",
      startedAt: "2026-11-10T01:30:00.000Z",
      localTimeContext: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -480,
        endUtcOffsetMinutes: -480,
        source: "provider_timezone",
      },
      sourceTree: {
        primary: {
          id: "kaya-climb-1",
          providerId: "kaya",
          sourceName: null,
          label: "Kaya",
          description: null,
          url: null,
          children: [],
        },
        otherSources: [
          {
            id: "whoop-climbing",
            providerId: "whoop",
            sourceName: null,
            label: "WHOOP",
            description: null,
            url: null,
            children: [],
          },
          {
            id: "kilter-session-1",
            providerId: "kilter",
            sourceName: null,
            label: "Kilter Board",
            description: null,
            url: null,
            children: [],
          },
          {
            id: "kilter-session-2",
            providerId: "kilter",
            sourceName: null,
            label: "Kilter Board",
            description: null,
            url: null,
            children: [],
          },
        ],
      },
      climbingLogSessions: [
        {
          id: "kilter-session-1",
          providerId: "kilter",
          memberActivityIds: ["kilter-log-1", "kilter-log-2"],
          firstLoggedAt: "2026-11-10T01:40:00.000Z",
          lastLoggedAt: "2026-11-10T01:44:33.000Z",
        },
        {
          id: "kilter-session-2",
          providerId: "kilter",
          memberActivityIds: ["kilter-log-3"],
          firstLoggedAt: "2026-11-10T02:03:00.000Z",
          lastLoggedAt: "2026-11-10T02:03:00.000Z",
        },
      ],
    },
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(
      canvas.getByText("Kilter Board · Logged climbs · 5:40 PM – 5:44 PM"),
    ).toBeVisible();
    await expect(canvas.getByText("Kilter Board · Logged climbs · 6:03 PM")).toBeVisible();
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage: Kaya" }));
    await waitFor(async () => {
      await expect(canvas.getAllByText("Kilter Board")).toHaveLength(2);
      await expect(canvas.getByText("WHOOP")).toBeVisible();
    });
  },
};

export const StandaloneKilterSession: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: "Kilter climbing",
      activityType: "climbing",
      displayedDate: "2026-11-09",
      startedAt: "2026-11-10T01:48:51.544Z",
      localTimeContext: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -480,
        endUtcOffsetMinutes: -480,
        source: "provider_timezone",
      },
      sourceTree: {
        primary: {
          id: "kilter-standalone-session",
          providerId: "kilter",
          sourceName: null,
          label: "Kilter Board",
          description: null,
          url: null,
          children: [],
        },
        otherSources: [],
      },
      climbingLogSessions: [
        {
          id: "kilter-standalone-session",
          providerId: "kilter",
          memberActivityIds: ["kilter-standalone-log"],
          firstLoggedAt: "2026-11-10T01:48:51.544Z",
          lastLoggedAt: "2026-11-10T01:48:51.544Z",
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Kilter Board · Logged climbs · 5:48 PM")).toBeVisible();
  },
};
export const RecordingDeviceExpanded: Story = {
  args: { hardware: garminActivitySourceHardware },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Lineage: Garmin Edge 530" }));
    await expect(canvas.getByText("Peloton Bike+")).toBeVisible();
    await expect(canvas.getByText("Morning Ride")).toBeVisible();
  },
};

export const WalkingCollapsed: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: "Walking",
      activityType: "walking",
      sourceTree: walkingActivitySourceTree,
    },
    hardware: walkingActivitySourceHardware,
  },
};
export const PrimarySourceWithoutTitle: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: null,
      activityType: "walking",
      primaryActivityType: "running",
      sourceTree: walkingActivitySourceTree,
    },
    hardware: walkingActivitySourceHardware,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await expect(canvas.getByText("Running")).toBeVisible();
    await expect(canvas.getByText("Walking")).toBeVisible();
  },
};
export const WalkingExpanded: Story = {
  args: {
    activity: {
      ...detailHeaderActivity,
      name: "Walking",
      activityType: "walking",
      sourceTree: walkingActivitySourceTree,
    },
    hardware: walkingActivitySourceHardware,
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Lineage: Asher’s Apple Watch" }),
    );
    await expect(canvas.getByText("Peloton")).toBeVisible();
  },
};

export const WithPhoto: Story = {
  args: {
    photos: {
      images: [
        {
          ...activityImageFixture,
          url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=300&q=80",
        },
      ],
      onRetry: () => undefined,
    },
  },
};
