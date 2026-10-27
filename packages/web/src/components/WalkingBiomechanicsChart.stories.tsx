import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WalkingBiomechanicsRow } from "dofek-server/types";
import { WalkingBiomechanicsChart } from "./WalkingBiomechanicsChart.tsx";

const readings: WalkingBiomechanicsRow[] = [
  {
    date: "2026-05-25",
    walkingSpeedKmh: 5.1,
    stepLengthCm: 72,
    doubleSupportPct: 24,
    asymmetryPct: 1.8,
    steadiness: 0.91,
  },
  {
    date: "2026-05-26",
    walkingSpeedKmh: 5.3,
    stepLengthCm: 74,
    doubleSupportPct: 23,
    asymmetryPct: 1.5,
    steadiness: 0.93,
  },
  {
    date: "2026-05-27",
    walkingSpeedKmh: 4.9,
    stepLengthCm: 70,
    doubleSupportPct: 26,
    asymmetryPct: 2.4,
    steadiness: 0.88,
  },
  {
    date: "2026-05-28",
    walkingSpeedKmh: 5.4,
    stepLengthCm: 75,
    doubleSupportPct: 22,
    asymmetryPct: 1.3,
    steadiness: 0.94,
  },
  {
    date: "2026-05-29",
    walkingSpeedKmh: 5.2,
    stepLengthCm: 73,
    doubleSupportPct: 23,
    asymmetryPct: 1.6,
    steadiness: 0.92,
  },
];

const meta = {
  title: "Hiking/WalkingBiomechanicsChart",
  component: WalkingBiomechanicsChart,
  tags: ["autodocs"],
  args: { data: readings },
  decorators: [
    (Story) => (
      <div className="w-[900px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WalkingBiomechanicsChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { data: [], loading: true } };
export const Empty: Story = { args: { data: [] } };
export const UnavailableSignals: Story = {
  args: {
    data: [
      {
        date: "2026-05-29",
        walkingSpeedKmh: null,
        stepLengthCm: null,
        doubleSupportPct: null,
        asymmetryPct: null,
        steadiness: 0.92,
      },
    ],
  },
};
export const PartialSignals: Story = {
  args: {
    data: readings.map((reading, index) =>
      index % 2 === 0
        ? reading
        : { ...reading, stepLengthCm: null, doubleSupportPct: null, asymmetryPct: null },
    ),
  },
};
