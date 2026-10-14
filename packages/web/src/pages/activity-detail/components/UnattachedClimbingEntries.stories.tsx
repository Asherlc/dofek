import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { Meta, StoryObj } from "@storybook/react-vite";
import "leaflet/dist/leaflet.css";
import { ClimbingEntryBreakdown } from "./ClimbingEntryBreakdown.tsx";
import { UnattachedClimbingEntries } from "./UnattachedClimbingEntries.tsx";

const meta = {
  title: "Activity Detail/Unattached Climbing Entries",
  component: UnattachedClimbingEntries,
  decorators: [
    (Story) => (
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted uppercase tracking-wider">Climbs</h2>
        <div className="card p-4">
          <Story />
        </div>
      </section>
    ),
  ],
  args: {
    suggestions: [
      {
        id: "entry-1",
        providerId: "mountain-project",
        sourceName: "Mountain Project",
        sourceLinks: [],
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
export const SwissCheese: Story = {
  args: {
    suggestions: meta.args.suggestions.map((entry) => ({
      ...entry,
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.4",
      routeName: "Swiss Cheese",
      sourceLinks: [
        {
          providerId: "mountain-project",
          kind: "route",
          url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
        },
      ],
      locationName:
        "California > San Francisco Bay Area > South Bay Area > Castle Rock and Sanborn Area > Goat Rock Area > Goat Rock",
      sent: null,
      ascentType: null,
      lead: false,
      context: {
        ...entry.context,
        locationPath: [
          "California",
          "San Francisco Bay Area",
          "South Bay Area",
          "Castle Rock and Sanborn Area",
          "Goat Rock Area",
          "Goat Rock",
        ].map((name) => ({
          name,
          externalId: null,
          kind: null,
        })),
        climbStyle: "top-rope",
        resultStyle: null,
      },
    })),
  },
};

export const WithAttachedClimbs: Story = {
  render: (args) => (
    <>
      <ClimbingEntryBreakdown
        entries={meta.args.suggestions.map((entry) => ({
          ...entry,
          id: "attached-entry",
          routeName: "The Corner",
          grade: "V3",
          gradeSystem: "v_scale",
          attempts: [],
          holdType: "crimp",
          wallAngleDegrees: null,
        }))}
      />
      <div className="mt-3 border-t border-border pt-3">
        <UnattachedClimbingEntries {...args} />
      </div>
    </>
  ),
};

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

const location: ClimbingMapLocation = {
  coordinates: { latitude: 37.234, longitude: -122.111 },
  scope: "climb",
  objectId: "blue-arete",
  providerId: "mountain-project",
  name: "Blue Arete",
};
const gridSuggestions = meta.args.suggestions.flatMap((entry) => [
  entry,
  {
    ...entry,
    id: "entry-2",
    routeName: "The very long north-facing ridge traverse above the exposed corner and upper wall",
  },
  { ...entry, id: "entry-3", routeName: "Indoor board tick" },
]);
const locations: Record<string, ClimbingMapLocation> = {
  "entry-1": location,
  "entry-2": { ...location, scope: "area", objectId: "goat-rock", name: "Goat Rock" },
};
export const ExactClimb: Story = { args: { locations } };
export const Area: Story = {
  args: {
    locations: {
      "entry-1": { ...location, scope: "area", objectId: "goat-rock", name: "Goat Rock" },
    },
  },
};
export const MixedGPS: Story = { args: { suggestions: gridSuggestions, locations } };
export const LongName: Story = { ...MixedGPS };
export const RepeatedPoint: Story = {
  args: { suggestions: gridSuggestions, locations: { "entry-1": location, "entry-2": location } },
};
export const IndependentAttachStates: Story = {
  ...MixedGPS,
  args: {
    ...MixedGPS.args,
    state: {
      "entry-1": { pending: true, error: null },
      "entry-2": { pending: false, error: "Entry no longer available. Refresh and try again." },
    },
  },
};
export const Narrow: Story = {
  ...IndependentAttachStates,
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Wide: Story = {
  ...IndependentAttachStates,
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
