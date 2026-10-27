import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingLogEntrySources } from "./ClimbingLogEntrySources";

const meta = {
  title: "Climbing/Entry Sources",
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
