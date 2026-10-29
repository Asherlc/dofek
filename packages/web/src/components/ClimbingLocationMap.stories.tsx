import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import "maplibre-gl/dist/maplibre-gl.css";
import { trpc } from "../lib/trpc.ts";
import { ClimbingLocationMap } from "./ClimbingLocationMap.tsx";
import { climbingLocationMapFixture } from "./climbing-location-map-test-helpers.ts";
import { createClimbingAttachmentFixture } from "./climbing-log-attachment-test-helpers.ts";

function ClimbingMapStoryFrame({ children }: { children: ReactNode }) {
  const fixture = useMemo(() => createClimbingAttachmentFixture(), []);
  return (
    <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
      <QueryClientProvider client={fixture.queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Training/ClimbingLocationMap",
  component: ClimbingLocationMap,
  parameters: { layout: "padded" },
  args: { data: climbingLocationMapFixture },
  decorators: [
    (Story) => (
      <ClimbingMapStoryFrame>
        <Story />
      </ClimbingMapStoryFrame>
    ),
  ],
} satisfies Meta<typeof ClimbingLocationMap>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const ExploreClimbs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cluster = await canvas.findByRole("button", { name: "3 climbs. Zoom in to explore." });
    fireEvent.click(cluster);
    const dot = await canvas.findByRole("button", { name: "2 climbs. Show climb details." });
    fireEvent.focus(dot);
    await waitFor(() =>
      expect(
        canvas.getByText("2 climbs. Show climb details.").getBoundingClientRect().width,
      ).toBeGreaterThan(100),
    );
    fireEvent.keyDown(dot, { key: "Enter" });
    const list = await canvas.findByRole("list", { name: "Climbs at this location" });
    await expect(within(list).getByText("Left Arete")).toBeVisible();
    await expect(within(list).getByText("Area location: Goat Rock · OpenBeta")).toBeVisible();
    await expect(
      within(list).getByRole("button", { name: "Attach to activity for Left Arete" }),
    ).toBeVisible();
  },
};
export const AttachToActivity: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "3 climbs. Zoom in to explore." }),
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "2 climbs. Show climb details." }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Attach to activity for Left Arete" }),
    );
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Attach Left Arete to activity",
    });
    await expect(
      within(dialog).findByRole("radio", { name: /Morning climbing/ }),
    ).resolves.toBeVisible();
    await expect(within(dialog).getByText("2026-10-05")).toBeVisible();
  },
};
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Wide: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Loading: Story = {
  args: { data: undefined, loading: true },
  parameters: {
    docs: {
      description: {
        story:
          "The reserved map area shows its processing status before location data or initial map tiles are ready.",
      },
    },
  },
};
export const Empty: Story = { args: { data: { bounds: null, nodes: [] } } };
export const Refreshing: Story = { args: { loading: true } };
