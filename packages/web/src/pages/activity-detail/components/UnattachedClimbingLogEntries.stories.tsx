import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import "maplibre-gl/dist/maplibre-gl.css";
import { climbingMapLocations, climbingMapLogs } from "./climbing-log-map-test-helpers.ts";
import { UnattachedClimbingLogEntries } from "./UnattachedClimbingLogEntries.tsx";

const meta = {
  title: "Climbing/Unattached Logs",
  component: UnattachedClimbingLogEntries,
  args: {
    suggestions: climbingMapLogs,
    locations: climbingMapLocations,
    error: null,
    isLoading: false,
    state: {},
    onAttach: fn(),
  },
} satisfies Meta<typeof UnattachedClimbingLogEntries>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {};
export const MixedGPS: Story = {};
export const SelectedOccurrence: Story = { args: { selectedEntryId: "tick-4" } };
export const CachedRefreshError: Story = {
  args: { error: new Error("Source is unavailable. Retry the sync.") },
};
export const Loading: Story = { args: { suggestions: undefined, isLoading: true } };
export const Empty: Story = { args: { suggestions: [] } };
export const ErrorState: Story = {
  args: { suggestions: undefined, error: new Error("Refresh the source connection.") },
};
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const Wide: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 1000, maxWidth: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
export const AttachStates: Story = {
  args: {
    state: {
      "tick-1": { pending: true, error: null },
      "tick-2": { pending: false, error: "Choose a climbing activity before attaching this log." },
    },
  },
  play: async ({ canvasElement, args, userEvent }) => {
    const canvas = within(canvasElement);
    const logs = within(canvas.getByRole("region", { name: "Unattached climbing logs" }));
    await expect(
      logs.getByRole("button", { name: "Attach entry 1, Swiss Cheese to this activity" }),
    ).toBeDisabled();
    await expect(logs.getByRole("alert")).toHaveTextContent("Choose a climbing activity");
    await userEvent.click(
      logs.getByRole("button", {
        name: /^Attach entry 2, The unusually long ridge traverse/,
      }),
    );
    await expect(args.onAttach).toHaveBeenCalledWith("tick-2");
  },
};

export const StatusOnlyError: Story = {
  args: { showEntries: false, error: new Error("Source is unavailable. Retry the sync.") },
};
export const StatusOnlyLoading: Story = {
  args: { showEntries: false, suggestions: undefined, isLoading: true },
};
