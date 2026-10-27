import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { expect, within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { ClimbingPhotos } from "./ClimbingPhotos.tsx";
import {
  type ClimbingPhotosScenario,
  createClimbingPhotosFixture,
} from "./climbing-photos-test-helpers.ts";

function PhotoStory({ scenario }: { scenario: ClimbingPhotosScenario }) {
  const fixture = useMemo(() => createClimbingPhotosFixture(scenario), [scenario]);
  return (
    <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
      <QueryClientProvider client={fixture.queryClient}>
        <ClimbingPhotos id="log-1" />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: "Climbing/ClimbingPhotos",
  component: ClimbingPhotos,
  args: { id: "log-1" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ClimbingPhotos>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Stored: Story = { render: () => <PhotoStory scenario="stored" /> };
export const Loading: Story = { render: () => <PhotoStory scenario="loading" /> };
export const Pending: Story = { render: () => <PhotoStory scenario="pending" /> };
export const Empty: Story = { render: () => <PhotoStory scenario="empty" /> };
export const QueryError: Story = { render: () => <PhotoStory scenario="error" /> };
export const RefreshError: Story = { render: () => <PhotoStory scenario="refresh-error" /> };
export const AcquisitionError: Story = { render: () => <PhotoStory scenario="terminal-error" /> };
export const IncompleteDiscovery: Story = { render: () => <PhotoStory scenario="incomplete" /> };
export const IncompleteDiscoveryWithStoredPhoto: Story = {
  render: () => <PhotoStory scenario="incomplete-stored" />,
};
export const FullPhoto: Story = {
  ...Stored,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Enlarge The arete" }),
    );
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByRole("button", { name: "Close photo" })).resolves.toBeTruthy();
  },
};
