import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClimbingAttemptLog } from "./ClimbingAttemptLog.tsx";

const meta = {
  title: "Training/ClimbingAttemptLog",
  component: ClimbingAttemptLog,
  args: {
    errorMessage: null,
    onSubmit: () => {},
    submitting: false,
  },
  tags: ["autodocs"],
} satisfies Meta<typeof ClimbingAttemptLog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultEmptyForm: Story = {};
export const Loading: Story = { args: { submitting: true } };
export const SaveError: Story = {
  args: { errorMessage: "A failed attempt requires a failure reason." },
};
