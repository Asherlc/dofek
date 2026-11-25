import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  anchorId,
  emptyPasses,
  fetchReadyGhost,
  firstVisitGhost,
  fixtureQuery,
  GhostFixtureProvider,
  ghostError,
  ghostResponse,
  nameErrorGhost,
} from "./fixtures/ghost-sessions.tsx";
import { GhostSessions } from "./GhostSessions.tsx";

const fetchProcessing: typeof fetch = async () =>
  ghostResponse({
    availability: "processing",
    sport: null,
    gpsCoverage: null,
    historyCoverage: "partial",
    nameStatus: "disabled",
    sections: [],
  });

const fetchFirstVisit: typeof fetch = async (input) =>
  ghostResponse(
    fixtureQuery(input).path === "/trpc/ghostSessions.get" ? firstVisitGhost : emptyPasses,
  );
const fetchError: typeof fetch = async () =>
  ghostError("INTERNAL_SERVER_ERROR", "Ghost Sessions could not be loaded.");
const fetchNameError: typeof fetch = (input, init) =>
  fixtureQuery(input).path === "/trpc/ghostSessions.get"
    ? Promise.resolve(ghostResponse(nameErrorGhost))
    : fetchReadyGhost(input, init);

function StoryFrame({
  fetchResponse = fetchReadyGhost,
  narrow = false,
}: {
  fetchResponse?: typeof fetch;
  narrow?: boolean;
}) {
  return (
    <div className="mx-auto w-full p-2 sm:p-4" style={{ maxWidth: narrow ? 375 : 1060 }}>
      <GhostFixtureProvider fetchResponse={fetchResponse}>
        <GhostSessions activityId={anchorId} />
      </GhostFixtureProvider>
    </div>
  );
}

const meta = {
  title: "Activity Detail/Ghost Sessions",
  component: GhostSessions,
  parameters: { layout: "fullscreen" },
  args: { activityId: anchorId },
} satisfies Meta<typeof GhostSessions>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  render: () => <StoryFrame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Previous best")).toBeVisible();
    await expect(await canvas.findByRole("slider", { name: "Replay elapsed time" })).toHaveValue(
      "0",
    );
  },
};

export const Loading: Story = {
  render: () => <StoryFrame fetchResponse={fetchProcessing} />,
};

export const FirstVisit: Story = {
  render: () => <StoryFrame fetchResponse={fetchFirstVisit} />,
};

const LoadError: Story = {
  render: () => <StoryFrame fetchResponse={fetchError} />,
};

export { LoadError as Error };

export const NameError: Story = {
  render: () => <StoryFrame fetchResponse={fetchNameError} />,
};

export const Narrow: Story = {
  render: () => <StoryFrame narrow />,
};
