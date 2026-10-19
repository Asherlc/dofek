import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources.tsx";

const meta = {
  title: "Activity Detail/ClimbingLogEntrySources",
  component: ClimbingLogEntrySources,
  args: {
    name: "Swiss Cheese",
    sourceName: "Mountain Project",
    links: [
      {
        providerId: "mountain-project",
        kind: "route",
        url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
      },
    ],
  },
} satisfies Meta<typeof ClimbingLogEntrySources>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Route: Story = {};
export const RouteWithTickHistory: Story = {
  args: {
    links: [
      ...meta.args.links,
      {
        providerId: "mountain-project",
        kind: "ticks",
        url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
      },
    ],
  },
};
export const MultipleSources: Story = {
  args: {
    sourceName: "Mountain Project, OpenBeta",
    links: [
      ...meta.args.links,
      {
        providerId: "mountain-project",
        kind: "ticks",
        url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
      },
      {
        providerId: "openbeta",
        kind: "route",
        url: "https://openbeta.io/climb/10000000-0000-4000-8000-000000000001",
      },
      { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Mountain Project" })).toHaveAttribute(
      "href",
      "https://www.mountainproject.com/user/110186720/ticks/ticks",
    );
    await expect(canvas.getByRole("link", { name: "OpenBeta" })).toHaveAttribute(
      "href",
      "https://openbeta.io/u/thickles/ticks",
    );
    await expect(
      canvas.getByRole("link", { name: "Swiss Cheese route on OpenBeta" }),
    ).toBeVisible();
  },
};
export const UnlinkedImport: Story = {
  args: { name: "Imported route", sourceName: "Kaya", links: [] },
};
export const MixedAttribution: Story = {
  args: { sourceName: "Mountain Project, Kaya" },
};
export const TickHistoryOnly: Story = {
  args: {
    links: [
      {
        providerId: "mountain-project",
        kind: "ticks",
        url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
      },
    ],
  },
};
