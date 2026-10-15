import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import "leaflet/dist/leaflet.css";
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
    const cards = canvas.getByRole("list", { name: "Unattached climbing logs" }).children;
    const first = cards[0];
    const second = cards[1];
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement))
      throw new Error("Expected suggestion cards");
    await expect(
      within(first).getByRole("button", { name: "Attach to this activity" }),
    ).toBeDisabled();
    await expect(within(second).getByRole("alert")).toHaveTextContent("Choose a climbing activity");
    await userEvent.click(within(second).getByRole("button", { name: "Attach to this activity" }));
    await expect(args.onAttach).toHaveBeenCalledWith("tick-2");
  },
};
