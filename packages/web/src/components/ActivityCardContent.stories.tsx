import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityCardContent, type ActivityCardData } from "./ActivityCardContent.tsx";
import { climbingSourceLocation } from "./ActivityMapTile.fixtures.ts";
import { activityPhotoFixture } from "./ActivityPhoto.fixtures.ts";

const units = new UnitConverter("metric");

const strengthActivity: ActivityCardData = {
  id: "strength-1",
  name: null,
  activityType: "strength",
  modality: null,
  startedAt: "2026-07-14T08:46:00-07:00",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  durationMin: 30,
  source: {
    origin: { status: "unresolved", candidateMemberActivityIds: [] },
    primarySourceLabel: "Strong (via Apple Health)",
    sourceCount: 1,
    overlapSummary: null,
  },
  lastProcessedAt: "2026-07-14T08:50:00-07:00",
  distanceMeters: null,
  distanceState: { status: "missing", reason: "Distance not recorded" },
  elevationGainM: null,
  elevationState: { status: "missing", reason: "Elevation not recorded" },
  location: null,
  stats: [{ status: "available", label: "Training Stress Score", value: "8.5" }],
};

const unavailableTrainingStressActivity: ActivityCardData = {
  ...strengthActivity,
  id: "strength-unavailable",
  stats: [
    {
      status: "missing",
      label: "Training Stress Score",
      reason: "Record average power, or record average heart rate and set maximum heart rate.",
    },
  ],
};

const unknownLocalTimeActivity: ActivityCardData = {
  ...strengthActivity,
  id: "strength-unknown-local-time",
  localTimeContext: {
    timezone: null,
    startUtcOffsetMinutes: null,
    endUtcOffsetMinutes: null,
    source: "unknown",
  },
};

const mappedActivity: ActivityCardData = {
  id: "run-1",
  name: "Morning Run",
  activityType: "running",
  modality: null,
  startedAt: "2026-07-14T07:38:00-07:00",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "device_timezone",
  },
  durationMin: 64,
  source: {
    origin: { status: "unresolved", candidateMemberActivityIds: [] },
    primarySourceLabel: "Garmin Connect",
    sourceCount: 2,
    overlapSummary: "2 matched source records · Garmin Connect selected by source priority",
  },
  lastProcessedAt: "2026-07-14T08:45:00-07:00",
  distanceMeters: 8530,
  distanceState: { status: "available" },
  elevationGainM: 493,
  elevationState: { status: "available" },
  location: {
    kind: "recorded_gps",
    centroidLat: 37.7749,
    centroidLng: -122.4194,
    mapPreview: {
      width: 512,
      height: 512,
      tiles: [
        {
          url: "https://tile.openstreetmap.org/19/83858/202646.png",
          x: 0,
          y: 0,
          width: 256,
          height: 256,
        },
        {
          url: "https://tile.openstreetmap.org/19/83859/202646.png",
          x: 256,
          y: 0,
          width: 256,
          height: 256,
        },
        {
          url: "https://tile.openstreetmap.org/19/83858/202647.png",
          x: 0,
          y: 256,
          width: 256,
          height: 256,
        },
        {
          url: "https://tile.openstreetmap.org/19/83859/202647.png",
          x: 256,
          y: 256,
          width: 256,
          height: 256,
        },
      ],
      routePath: [
        { x: 82, y: 410 },
        { x: 178, y: 332 },
        { x: 264, y: 286 },
        { x: 356, y: 178 },
        { x: 438, y: 92 },
      ],
    },
  },
  stats: [{ status: "available", label: "Training Stress Score", value: "41" }],
};

const meta = {
  title: "Activities/ActivityCardContent",
  component: ActivityCardContent,
  tags: ["autodocs"],
  args: {
    activity: strengthActivity,
    units,
    selectMode: false,
    selected: false,
  },
  decorators: [
    (Story) => (
      <div className="w-[1400px] max-w-full bg-background p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivityCardContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NonMapActivity: Story = {
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const MappedActivity: Story = {
  args: { activity: mappedActivity },
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const IndoorCycling: Story = {
  args: {
    activity: {
      ...strengthActivity,
      id: "indoor-ride",
      name: "60 min Power Zone Ride",
      activityType: "cycling",
      modality: "indoor",
      durationMin: 60,
      distanceMeters: 0,
      distanceState: { status: "available" },
      source: {
        origin: { status: "unresolved", candidateMemberActivityIds: [] },
        primarySourceLabel: "Peloton",
        sourceCount: 1,
        overlapSummary: null,
      },
      stats: [{ status: "available", label: "Training Stress Score", value: "65" }],
    },
  },
  decorators: NonMapActivity.decorators,
};

export const VirtualCycling: Story = {
  args: {
    activity: {
      ...strengthActivity,
      id: "virtual-ride",
      name: "Virtual Ride",
      activityType: "cycling",
      modality: "virtual",
      durationMin: 60,
      distanceMeters: 30_000,
      distanceState: { status: "available" },
      elevationGainM: 120,
      elevationState: { status: "available" },
      source: {
        origin: { status: "unresolved", candidateMemberActivityIds: [] },
        primarySourceLabel: "Zwift",
        sourceCount: 1,
        overlapSummary: null,
      },
      stats: [{ status: "available", label: "Training Stress Score", value: "65" }],
    },
  },
  decorators: NonMapActivity.decorators,
};

export const ProcessingMap: Story = {
  ...MappedActivity,
  args: { activity: { ...mappedActivity, location: { kind: "processing" } } },
};

export const ClimbingSourceLocations: Story = {
  parameters: { layout: "fullscreen" },
  args: {
    activity: {
      ...strengthActivity,
      id: "climbing-1",
      name: "Afternoon climbing",
      activityType: "climbing",
      durationMin: 120,
      source: {
        origin: { status: "unresolved", candidateMemberActivityIds: [] },
        primarySourceLabel: "Mountain Project",
        sourceCount: 1,
        overlapSummary: null,
      },
      stats: [{ status: "available", label: "Climbs", value: "3" }],
      location: climbingSourceLocation,
    },
  },
  decorators: MappedActivity.decorators,
};

export const UnavailableTrainingStress: Story = {
  args: { activity: unavailableTrainingStressActivity },
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const UnknownLocalTime: Story = {
  args: { activity: unknownLocalTimeActivity },
  decorators: [
    (Story) => (
      <div className="card overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export const ExampleGrid: Story = {
  render: () => (
    <div className="grid gap-4 lg:grid-cols-2">
      {[mappedActivity, strengthActivity, unavailableTrainingStressActivity].map((activity) => (
        <article key={activity.id} className="card h-full overflow-hidden">
          <ActivityCardContent
            activity={activity}
            units={units}
            selectMode={false}
            selected={false}
          />
        </article>
      ))}
    </div>
  ),
};

export const PrimaryRecordingProvider: Story = {
  args: {
    activity: {
      ...mappedActivity,
      source: {
        origin: {
          status: "resolved",
          memberActivityId: "00000000-0000-4000-8000-000000000001",
          providerId: "garmin",
          sourceName: "Garmin Edge 530",
        },
        primarySourceLabel: "Garmin",
        sourceCount: 3,
        overlapSummary: "3 matched source records",
      },
    },
  },
  decorators: MappedActivity.decorators,
};

export const KayaProviderLogo: Story = {
  args: {
    activity: {
      ...strengthActivity,
      name: "Kaya climbing",
      activityType: "climbing",
      durationMin: 48,
      source: {
        origin: {
          status: "resolved",
          memberActivityId: "00000000-0000-4000-8000-000000000001",
          providerId: "kaya",
          sourceName: null,
        },
        primarySourceLabel: "Kaya",
        sourceCount: 1,
        overlapSummary: null,
      },
      location: climbingSourceLocation,
      stats: [{ status: "available", label: "Training Stress Score", value: "23.4" }],
    },
  },
  decorators: MappedActivity.decorators,
};

export const UnresolvedRecordingOrigin: Story = {
  args: {
    activity: {
      ...mappedActivity,
      source: {
        origin: { status: "unresolved", candidateMemberActivityIds: [] },
        primarySourceLabel: null,
        sourceCount: 2,
        overlapSummary: "2 matched source records",
      },
    },
  },
  decorators: MappedActivity.decorators,
};

export const PrimaryProviderWithoutLogo: Story = {
  args: {
    activity: {
      ...strengthActivity,
      name: "A long activity title that should leave space for its provider logo",
      source: {
        origin: {
          status: "resolved",
          memberActivityId: "00000000-0000-4000-8000-000000000001",
          providerId: "mountain-project",
          sourceName: null,
        },
        primarySourceLabel: "Mountain Project",
        sourceCount: 1,
        overlapSummary: null,
      },
    },
  },
  decorators: NonMapActivity.decorators,
};

export const AppleHealthSourceApps: Story = {
  render: () => (
    <div className="grid gap-4 lg:grid-cols-2">
      {["Strong", "Hang Ten"].map((sourceName) => (
        <article key={sourceName} className="card overflow-hidden">
          <ActivityCardContent
            activity={{
              ...strengthActivity,
              name: sourceName === "Strong" ? "Morning strength" : "Hangboard session",
              source: {
                origin: {
                  status: "resolved",
                  memberActivityId: "00000000-0000-4000-8000-000000000001",
                  providerId: "apple_health",
                  sourceName,
                },
                primarySourceLabel: `${sourceName} (via Apple Health)`,
                sourceCount: 1,
                overlapSummary: null,
              },
            }}
            units={units}
            selectMode={false}
            selected={false}
          />
        </article>
      ))}
    </div>
  ),
};

export const PhotoWithoutMap: Story = {
  args: { activity: strengthActivity, photo: activityPhotoFixture },
};

export const MapBeforePhoto: Story = {
  args: { activity: mappedActivity, photo: activityPhotoFixture },
};
