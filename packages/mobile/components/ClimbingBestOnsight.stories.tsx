import {
  climbingBestOnsightFixture,
  emptyClimbingBestOnsightFixture,
} from "@dofek/training/fixtures/climbing-best-onsight";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { trpc } from "../lib/trpc";
import { ClimbingBestOnsight } from "./ClimbingBestOnsight";
import { climbingAttachmentSafeAreaMetrics } from "./climbing-log-attachment-test-helpers";
import { createClimbingRecordDetailLink } from "./fixtures/climbing-best-onsight-story-helpers";

function StoryFrame({ children }: { children: ReactNode }) {
  const { queryClient, client } = useMemo(() => {
    const queryClient = new QueryClient();
    return {
      queryClient,
      client: trpc.createClient({ links: [createClimbingRecordDetailLink()] }),
    };
  }, []);
  return (
    <SafeAreaProvider initialMetrics={climbingAttachmentSafeAreaMetrics}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </trpc.Provider>
    </SafeAreaProvider>
  );
}

const meta = {
  title: "Components/ClimbingBestOnsight",
  component: ClimbingBestOnsight,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <StoryFrame>
        <View style={{ width: "100%", maxWidth: 560, padding: 16 }}>
          <Story />
        </View>
      </StoryFrame>
    ),
  ],
  args: { data: climbingBestOnsightFixture() },
} satisfies Meta<typeof ClimbingBestOnsight>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const AllEmpty: Story = { args: { data: emptyClimbingBestOnsightFixture() } };
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Idle: Story = { args: { data: undefined } };
export const LoadError: Story = {
  args: { data: undefined, error: new Error("Annual onsights unavailable") },
};
export const BackgroundRefreshError: Story = {
  args: {
    data: climbingBestOnsightFixture(),
    error: new Error("Reconnect the climbing provider"),
  },
};
