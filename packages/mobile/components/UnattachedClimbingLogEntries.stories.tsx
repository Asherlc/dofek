import type { Meta, StoryObj } from "@storybook/react-native";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { UnattachedClimbingLogEntries } from "./UnattachedClimbingLogEntries";

const meta = {
  title: "Climbing/Unattached Logs",
  component: UnattachedClimbingLogEntries,
  args: {
    suggestions: [climbingLogEntryFixture({ climb: climbingClimbFixture() })],
    error: null,
    isLoading: false,
    state: {},
    onAttach: () => {},
  },
} satisfies Meta<typeof UnattachedClimbingLogEntries>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {};
export const CachedRefreshError: Story = {
  args: { error: new Error("Source is unavailable. Retry the sync.") },
};
export const Loading: Story = { args: { suggestions: undefined, isLoading: true } };
