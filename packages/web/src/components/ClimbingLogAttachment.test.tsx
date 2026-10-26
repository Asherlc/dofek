/** @vitest-environment jsdom */
import { QueryClientProvider } from "@tanstack/react-query";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getQueryKey } from "@trpc/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trpc } from "../lib/trpc.ts";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment.tsx";
import {
  climbingAttachmentActivities,
  createClimbingAttachmentFixture,
} from "./climbing-log-attachment-test-helpers.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../lib/telemetry.ts", () => ({ captureException }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAttachment(options: Parameters<typeof createClimbingAttachmentFixture>[0] = {}) {
  const fixture = createClimbingAttachmentFixture(options);
  function AttachmentHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Attach Left Arete
        </button>
        {open ? (
          <ClimbingLogAttachment
            entry={{ id: "tick-2", label: "Left Arete", date: "2026-10-05" }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    );
  }
  render(
    <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
      <QueryClientProvider client={fixture.queryClient}>
        <AttachmentHarness />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  const trigger = screen.getByRole("button", { name: "Attach Left Arete" });
  trigger.focus();
  fireEvent.click(trigger);
  return { fixture, trigger };
}

describe("ClimbingLogAttachment", () => {
  it("requires an explicit activity choice for the log date and displays server times and sources", async () => {
    const { fixture } = renderAttachment();
    const dialog = screen.getByRole("dialog", { name: "Attach Left Arete to activity" });
    expect(within(dialog).getByText("2026-10-05")).toBeVisible();
    const morning = await within(dialog).findByRole("radio", { name: /Morning climbing/ });
    expect(morning).not.toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Approach hike/ })).not.toBeChecked();
    expect(within(dialog).getByText(/08:30.*Climbing.*Garmin/)).toBeVisible();
    expect(within(dialog).getByText(/15:45.*Hiking.*Strava/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Attach" })).toBeDisabled();
    expect(fixture.requests).toEqual([
      { path: "climbing.attachmentActivities", input: { date: "2026-10-05" } },
    ]);
  });

  it("attaches exactly the chosen log and activity and refreshes their affected cached views", async () => {
    const { fixture } = renderAttachment();
    const keys = [
      getQueryKey(trpc.climbing.locationMap, { days: 90 }, "query"),
      getQueryKey(trpc.climbing.activityLogEntries, { activityId: "activity-1" }, "query"),
      getQueryKey(
        trpc.climbing.unattachedClimbingLogEntries,
        { activityId: "activity-1" },
        "query",
      ),
      getQueryKey(trpc.climbing.sessionSummary, { days: 90 }, "query"),
      getQueryKey(trpc.climbing.gradeProgression, { days: 90 }, "query"),
      getQueryKey(trpc.climbing.strengths),
      getQueryKey(trpc.climbing.volumeByGrade, { days: 90 }, "query"),
      getQueryKey(trpc.activity.list, { limit: 10 }, "query"),
      getQueryKey(trpc.calendar.weekList, undefined, "query"),
    ];
    for (const key of keys) fixture.queryClient.setQueryData(key, []);
    fireEvent.click(await screen.findByRole("radio", { name: /Approach hike/ }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fixture.requests.filter(({ path }) => path === "climbing.attachClimbingLogEntry"),
    ).toEqual([
      {
        path: "climbing.attachClimbingLogEntry",
        input: { climbingLogEntryId: "tick-2", activityId: "22222222-2222-4222-8222-222222222222" },
      },
    ]);
    for (const key of keys)
      expect(fixture.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("shows loading before the first activity response", () => {
    renderAttachment({ pending: "query" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading same-day activities");
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  });

  it("explains when no climbing or hiking activities were recorded that day", async () => {
    renderAttachment({ activities: [] });
    expect(
      await screen.findByText("No climbing or hiking activities recorded on this day."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  });

  it("shows the server query error and lets the user retry without changing the log date", async () => {
    const options: { queryError?: string } = {
      queryError: "Reconnect Garmin to load your recorded activities.",
    };
    const { fixture } = renderAttachment(options);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reconnect Garmin to load your recorded activities.",
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      component: "ClimbingLogAttachment",
    });
    expect(captureException).toHaveBeenCalledOnce();
    options.queryError = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("radio", { name: /Morning climbing/ })).toBeVisible();
    expect(fixture.requests.filter(({ path }) => path === "climbing.attachmentActivities")).toEqual(
      [
        { path: "climbing.attachmentActivities", input: { date: "2026-10-05" } },
        { path: "climbing.attachmentActivities", input: { date: "2026-10-05" } },
      ],
    );
  });

  it("keeps cached choices visible if a background refresh fails", async () => {
    const options: { queryError?: string } = {};
    const { fixture } = renderAttachment(options);
    fireEvent.click(await screen.findByRole("radio", { name: /Morning climbing/ }));
    options.queryError = "Activity refresh unavailable. Try again.";
    await act(() =>
      fixture.queryClient.invalidateQueries({
        queryKey: getQueryKey(trpc.climbing.attachmentActivities),
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(options.queryError);
    expect(screen.getByRole("radio", { name: /Morning climbing/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Approach hike/ })).toBeVisible();
  });

  it("keeps the selected activity available after a specific attachment error", async () => {
    const options = { mutationError: "This log is already attached. Refresh your climbing logs." };
    renderAttachment(options);
    fireEvent.click(await screen.findByRole("radio", { name: /Approach hike/ }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(options.mutationError);
    expect(screen.getByRole("radio", { name: /Approach hike/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Attach" })).toBeEnabled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      component: "ClimbingLogAttachment",
    });
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("blocks duplicate submissions and dismissal while attachment is pending", async () => {
    const { fixture } = renderAttachment({ pending: "mutation" });
    fireEvent.click(await screen.findByRole("radio", { name: /Approach hike/ }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    const submit = await screen.findByRole("button", { name: "Attaching…" });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Morning climbing/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(submit);
    fireEvent.keyDown(submit, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(
      fixture.requests.filter(({ path }) => path === "climbing.attachClimbingLogEntry"),
    ).toHaveLength(1);
  });

  it.each(["Cancel", "Escape"])(
    "closes via %s without attaching and restores focus",
    async (action) => {
      const { fixture, trigger } = renderAttachment();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toHaveFocus());
      if (action === "Cancel") fireEvent.click(cancel);
      else fireEvent.keyDown(cancel, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(trigger).toHaveFocus();
      expect(
        fixture.requests.filter(({ path }) => path === "climbing.attachClimbingLogEntry"),
      ).toHaveLength(0);
      fireEvent.click(trigger);
      expect(await screen.findByRole("radio", { name: /Morning climbing/ })).not.toBeChecked();
    },
  );

  it.each([null, "", "   "])(
    "labels recordings with name %j using their activity type",
    async (name) => {
      renderAttachment({
        activities: climbingAttachmentActivities.map((activity) => ({ ...activity, name })),
      });
      expect(await screen.findByRole("radio", { name: "Climbing 08:30 · Garmin" })).toBeVisible();
      expect(screen.getByRole("radio", { name: "Hiking 15:45 · Strava" })).toBeVisible();
    },
  );
});
