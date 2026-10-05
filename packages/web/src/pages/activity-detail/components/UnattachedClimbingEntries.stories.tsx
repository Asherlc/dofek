import type { Meta, StoryObj } from "@storybook/react-vite";
import { UnattachedClimbingEntries } from "./UnattachedClimbingEntries.tsx";

const meta = {
  title: "Activity Detail/Unattached Climbing Entries",
  component: UnattachedClimbingEntries,
  args: {
    suggestions: [
      {
        id: "entry-1",
        providerId: "mountain-project",
        sourceName: "Mountain Project",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        ascentType: "Flash",
        attemptCount: null,
        lead: null,
        routeName: "Blue Arete",
        locationName: "Pacific Pipe",
        context: {
          providerId: "mountain-project",
          locationPath: [{ name: "Pacific Pipe", externalId: null, kind: null }],
          board: null,
          wallAngle: null,
          climbStyle: null,
          resultStyle: "Flash",
        },
      },
    ],
    error: null,
    isLoading: false,
    state: {},
    onAttach: () => undefined,
  },
} satisfies Meta<typeof UnattachedClimbingEntries>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Onsight: Story = {
  args: {
    suggestions: meta.args.suggestions.map((entry) => ({
      ...entry,
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.6",
      routeName: "Left Arete",
      ascentType: "Onsight",
      lead: true,
      context: { ...entry.context, climbStyle: "lead", resultStyle: "Onsight" },
    })),
  },
};

export const Redpoint: Story = {
  args: {
    suggestions: meta.args.suggestions.map((entry) => ({
      ...entry,
      ascentType: "Redpoint",
      attemptCount: 7,
      context: { ...entry.context, resultStyle: "Redpoint" },
    })),
  },
};

export const Loading: Story = {
  args: { suggestions: undefined, isLoading: true },
};

export const Empty: Story = { args: { suggestions: [] } };

export const LoadError: Story = {
  args: { suggestions: undefined, error: new Error("Could not load climbing entries") },
};

export const Attaching: Story = {
  args: { state: { "entry-1": { pending: true, error: null } } },
};

export const AttachError: Story = {
  args: { state: { "entry-1": { pending: false, error: "This entry is no longer available." } } },
};
