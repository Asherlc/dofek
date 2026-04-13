import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { VerticalAscentChart, type VerticalAscentDataPoint } from "./VerticalAscentChart";

const SAMPLE_DATA: VerticalAscentDataPoint[] = [
  {
    date: "2024-05-01",
    activityName: "Alpe d'Huez",
    verticalAscentRate: 1100,
    elevationGainMeters: 1120,
    climbingMinutes: 61,
  },
  {
    date: "2024-05-08",
    activityName: "Col du Galibier",
    verticalAscentRate: 950,
    elevationGainMeters: 1230,
    climbingMinutes: 78,
  },
  {
    date: "2024-05-15",
    activityName: "Hill Repeats",
    verticalAscentRate: 1350,
    elevationGainMeters: 320,
    climbingMinutes: 14,
  },
  {
    date: "2024-05-22",
    activityName: "Mont Ventoux",
    verticalAscentRate: 880,
    elevationGainMeters: 1610,
    climbingMinutes: 110,
  },
  {
    date: "2024-06-01",
    activityName: "Local Climb",
    verticalAscentRate: 1050,
    elevationGainMeters: 450,
    climbingMinutes: 26,
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
