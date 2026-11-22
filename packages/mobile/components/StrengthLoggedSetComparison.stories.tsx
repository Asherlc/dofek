import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { StrengthLoggedSetComparison } from "./StrengthLoggedSetComparison";
import { loggedSetFixture } from "./strength-logged-set-fixture";

const meta = {
  title: "Training/StrengthLoggedSetComparison",
  component: StrengthLoggedSetComparison,
  args: { data: loggedSetFixture, units: new UnitConverter("metric") },
} satisfies Meta<typeof StrengthLoggedSetComparison>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { data: undefined, loading: true } };
export const Empty: Story = { args: { data: { ...loggedSetFixture, exercises: [] } } };
export const QueryError: Story = {
  args: { data: undefined, error: { message: "Unable to load comparison" } },
};
export const SingleObservation: Story = {
  args: {
    data: {
      ...loggedSetFixture,
      exercises: loggedSetFixture.exercises.slice(1),
    },
  },
};
