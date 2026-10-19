import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { trpc } from "../lib/trpc";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment";
import {
  type ClimbingAttachmentFixtureOptions,
  climbingAttachmentSafeAreaMetrics,
  createClimbingAttachmentTestClient,
} from "./climbing-log-attachment-test-helpers";

const entry = {
  id: "00000000-0000-4000-8000-000000000003",
  label: "Swiss Cheese repeat",
  date: "2026-10-11",
};

function AttachmentStory({ options }: { options?: ClimbingAttachmentFixtureOptions }) {
  const fixture = useMemo(() => createClimbingAttachmentTestClient(options), [options]);
  const [open, setOpen] = useState(true);
  return (
    <SafeAreaProvider initialMetrics={climbingAttachmentSafeAreaMetrics}>
      <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
        <QueryClientProvider client={fixture.queryClient}>
          <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
            <Text>Open attachment picker</Text>
          </Pressable>
          {open && <ClimbingLogAttachment entry={entry} onClose={() => setOpen(false)} />}
        </QueryClientProvider>
      </trpc.Provider>
    </SafeAreaProvider>
  );
}

const meta = {
  title: "Climbing/ClimbingLogAttachment",
  component: ClimbingLogAttachment,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ClimbingLogAttachment>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SameDayActivities: Story = { render: () => <AttachmentStory /> };
export const Loading: Story = { render: () => <AttachmentStory options={{ loading: true }} /> };
export const NoSameDayActivities: Story = {
  render: () => <AttachmentStory options={{ activities: [] }} />,
};
export const QueryError: Story = {
  render: () => (
    <AttachmentStory
      options={{ queryError: "Activities are unavailable. Reconnect Garmin and retry." }}
    />
  ),
};
export const Attaching: Story = {
  render: () => <AttachmentStory options={{ mutationPending: true }} />,
};
export const AttachmentError: Story = {
  render: () => (
    <AttachmentStory
      options={{
        mutationError: "This climbing log is already attached. Refresh the climbing map.",
      }}
    />
  ),
};
