import type { Meta, StoryObj } from "@storybook/react-vite";
import { UnattachedMountainProjectTicks } from "./UnattachedMountainProjectTicks.tsx";

const meta = {
  title: "Activity Detail/Unattached Mountain Project Ticks",
  component: UnattachedMountainProjectTicks,
  args: {
    suggestions: [
      {
        id: "tick-1",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        attemptCount: 3,
        lead: null,
        routeName: "Blue Arete",
        locationName: "Pacific Pipe",
      },
    ],
    error: null,
    isLoading: false,
    state: {},
    onAttach: () => undefined,
  },
} satisfies Meta<typeof UnattachedMountainProjectTicks>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: { suggestions: undefined, isLoading: true },
};

export const Empty: Story = { args: { suggestions: [] } };

export const LoadError: Story = {
  args: { suggestions: undefined, error: new Error("Could not load ticks") },
};

export const Attaching: Story = {
  args: { state: { "tick-1": { pending: true, error: null } } },
};

export const AttachError: Story = {
  args: { state: { "tick-1": { pending: false, error: "This tick is no longer available." } } },
};
