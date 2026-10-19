import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { expect, within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment.tsx";
import { createClimbingAttachmentFixture } from "./climbing-log-attachment-test-helpers.ts";

type AttachmentScenario =
  | "ready"
  | "loading"
  | "empty"
  | "query-error"
  | "mutation-error"
  | "saving";

function AttachmentStory({ scenario }: { scenario: AttachmentScenario }) {
  const [open, setOpen] = useState(true);
  const fixture = useMemo(
    () =>
      createClimbingAttachmentFixture({
        activities: scenario === "empty" ? [] : undefined,
        pending: scenario === "loading" ? "query" : scenario === "saving" ? "mutation" : undefined,
        queryError:
          scenario === "query-error"
            ? "Reconnect Garmin to load your recorded activities."
            : undefined,
        mutationError:
          scenario === "mutation-error"
            ? "This log is already attached. Refresh your climbing logs."
            : undefined,
      }),
    [scenario],
  );
  return (
    <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
      <QueryClientProvider client={fixture.queryClient}>
        <button type="button" className="text-accent" onClick={() => setOpen(true)}>
          Attach to activity
        </button>
        {open ? (
          <ClimbingLogAttachment
            entry={{ id: "tick-2", label: "Left Arete", date: "2026-10-05" }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Training/ClimbingLogAttachment",
  component: ClimbingLogAttachment,
  parameters: { layout: "fullscreen" },
  args: {
    entry: { id: "tick-2", label: "Left Arete", date: "2026-10-05" },
    onClose: () => {},
  },
} satisfies Meta<typeof ClimbingLogAttachment>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <AttachmentStory scenario="ready" />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByRole("radio", { name: /Morning climbing/ })).resolves.not.toBeChecked();
    await expect(page.getByRole("button", { name: "Attach" })).toBeDisabled();
  },
};
export const Loading: Story = { render: () => <AttachmentStory scenario="loading" /> };
export const NoSameDayActivities: Story = { render: () => <AttachmentStory scenario="empty" /> };
export const ActivityQueryError: Story = {
  render: () => <AttachmentStory scenario="query-error" />,
};
export const AttachmentError: Story = {
  render: () => <AttachmentStory scenario="mutation-error" />,
  play: async ({ canvasElement, userEvent }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("radio", { name: /Approach hike/ }));
    await userEvent.click(page.getByRole("button", { name: "Attach" }));
    await expect(page.findByRole("alert")).resolves.toHaveTextContent(
      "This log is already attached",
    );
  },
};
export const Saving: Story = {
  render: () => <AttachmentStory scenario="saving" />,
  play: async ({ canvasElement, userEvent }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("radio", { name: /Approach hike/ }));
    await userEvent.click(page.getByRole("button", { name: "Attach" }));
    await expect(page.findByRole("button", { name: "Attaching…" })).resolves.toBeDisabled();
  },
};
export const Narrow: Story = {
  render: () => <AttachmentStory scenario="ready" />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
