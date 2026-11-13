import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { VerticalAscentChart, type VerticalAscentDataPoint } from "./VerticalAscentChart";

const SAMPLE_DATA: VerticalAscentDataPoint[] = [
  {
    activityId: "00000000-0000-4000-8000-000000000001",
    date: "2024-05-01",
    activityName: "Alpe d'Huez",
    activityType: "road_cycling",
    modality: "road",
    verticalAscentRate: 1100,
    elevationGainMeters: 1120,
    elapsedMinutes: 61,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000002",
    date: "2024-05-08",
    activityName: "Col du Galibier",
    activityType: "road_cycling",
    modality: "road",
    verticalAscentRate: 950,
    elevationGainMeters: 1230,
    elapsedMinutes: 78,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000003",
    date: "2024-05-15",
    activityName: "Hill Repeats",
    activityType: "mountain_biking",
    modality: "mountain",
    verticalAscentRate: 1350,
    elevationGainMeters: 320,
    elapsedMinutes: 14,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000004",
    date: "2024-05-22",
    activityName: "Mont Ventoux",
    activityType: "gravel_cycling",
    modality: "gravel",
    verticalAscentRate: 880,
    elevationGainMeters: 1610,
    elapsedMinutes: 110,
  },
  {
    activityId: "00000000-0000-4000-8000-000000000005",
    date: "2024-06-01",
    activityName: "Local Climb",
    activityType: "gravel_cycling",
    modality: "gravel",
    verticalAscentRate: 1050,
    elevationGainMeters: 450,
    elapsedMinutes: 26,
  },
];

const meta = {
  title: "Charts/VerticalAscentChart",
  component: VerticalAscentChart,
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: "#f5f7f2", width: 360 }}>
        <Story />
      </View>
    ),
  ],
  args: {
    data: SAMPLE_DATA,
    units: new UnitConverter("metric"),
  },
} satisfies Meta<typeof VerticalAscentChart>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Imperial: Story = {
  args: {
    units: new UnitConverter("imperial"),
  },
};

export const SinglePoint: Story = {
  args: {
    data: [SAMPLE_DATA[0]],
  },
};

export const Empty: Story = {
  args: {
    data: [],
  },
};
