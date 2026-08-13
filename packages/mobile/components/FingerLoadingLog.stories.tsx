import type { Meta, StoryObj } from "@storybook/react-native";
import { FingerLoadingLog } from "./FingerLoadingLog";

const meta = {
  title: "Training/FingerLoadingLog",
  component: FingerLoadingLog,
  args: {
    errorMessage: null,
    latest: {
      bodyweightKg: 72,
      edgeSizeMm: 20,
      exercise: "max_hang",
      externalLoadKg: 18,
      gripPosition: "half_crimp",
      holdDurationSeconds: 10,
      laterality: "both",
      notes: null,
      restIntervalSeconds: 180,
      setCount: 5,
    },
    loading: false,
    onSubmit: () => {},
    submitting: false,
    unitSystem: "metric",
  },
} satisfies Meta<typeof FingerLoadingLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { loading: true } };
export const EmptyNoPreviousSession: Story = { args: { latest: null } };
export const Imperial: Story = { args: { unitSystem: "imperial" } };
export const SaveError: Story = { args: { errorMessage: "The session could not be saved." } };
