import type { Meta, StoryObj } from "@storybook/react-native";
import { ClimbingAttemptLog } from "./ClimbingAttemptLog";

const meta = {
  title: "Training/ClimbingAttemptLog",
  component: ClimbingAttemptLog,
  args: {
    errorMessage: null,
    onSubmit: () => {},
    submitting: false,
  },
} satisfies Meta<typeof ClimbingAttemptLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultEmptyForm: Story = {};
export const Loading: Story = { args: { submitting: true } };
export const SaveError: Story = {
  args: { errorMessage: "A failed attempt requires a failure reason." },
};
