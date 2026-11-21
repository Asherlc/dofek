import {
  climbingBestOnsightFixture,
  emptyClimbingBestOnsightFixture,
} from "@dofek/training/fixtures/climbing-best-onsight";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { ClimbingBestOnsight } from "./ClimbingBestOnsight.tsx";
import { createClimbingRecordDetailLink } from "./climbing-best-onsight-story-helpers.ts";

function StoryFrame({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const client = useMemo(
    () => trpc.createClient({ links: [createClimbingRecordDetailLink()] }),
    [],
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Components/ClimbingBestOnsight",
  component: ClimbingBestOnsight,
  tags: ["autodocs"],
  args: { data: climbingBestOnsightFixture() },
  decorators: [
    (Story) => (
      <StoryFrame>
        <div
          className="card p-4"
          style={{ width: "min(736px, calc(100vw - 32px))", maxWidth: "100%" }}
        >
          <Story />
        </div>
      </StoryFrame>
    ),
  ],
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
