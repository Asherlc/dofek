import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingSessionSummaryTable } from "./ClimbingSessionSummaryTable.tsx";

const sessions = [
  {
    activityId: "activity-1",
    date: "2026-07-09",
    name: "Kaya climbing at Touchstone Pacific Pipe",
    locationName: "Touchstone Pacific Pipe",
    attempts: 11,
    sends: 7,
    hardestBoulderGrade: "V4",
    hardestBoulderGradeSortValue: 4,
    hardestRouteGrade: null,
    hardestRouteGradeSortValue: null,
  },
  {
    activityId: "activity-2",
    date: "2026-07-12",
    name: "Kaya climbing at Mission Cliffs",
    locationName: "Mission Cliffs",
    attempts: 6,
    sends: 4,
    hardestBoulderGrade: "V3",
    hardestBoulderGradeSortValue: 3,
    hardestRouteGrade: "5.10a",
    hardestRouteGradeSortValue: 5101,
  },
];

const meta = {
  title: "Components/ClimbingSessionSummaryTable",
  component: ClimbingSessionSummaryTable,
  tags: ["autodocs"],
  args: {
    data: sessions,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 760 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ClimbingSessionSummaryTable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    data: [],
  },
};

export const Loading: Story = {
  args: {
    data: [],
    loading: true,
  },
};
