import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getQueryKey } from "@trpc/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ClimbingAttachmentActivity } from "../../server/src/contracts/climbing-log-contracts.ts";
import { captureException } from "../lib/telemetry";
import { trpc } from "../lib/trpc";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment";
import {
  type ClimbingAttachmentFixtureOptions,
  climbingAttachmentActivities,
  createClimbingAttachmentTestClient,
} from "./climbing-log-attachment-test-helpers";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));

const entry = {
  id: "00000000-0000-4000-8000-000000000003",
  label: "Swiss Cheese repeat",
  date: "2026-10-11",
};

function renderPicker(
  options: ClimbingAttachmentFixtureOptions = {},
  cachedActivities?: ClimbingAttachmentActivity[],
) {
  const fixture = createClimbingAttachmentTestClient(options);
  if (cachedActivities) {
    fixture.queryClient.setQueryData(
      getQueryKey(trpc.climbing.attachmentActivities, { date: entry.date }, "query"),
      cachedActivities,
    );
  }
  const onClose = vi.fn();
  function picker(open: boolean) {
    return (
      <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
        <QueryClientProvider client={fixture.queryClient}>
          {open && <ClimbingLogAttachment entry={entry} onClose={onClose} />}
        </QueryClientProvider>
      </trpc.Provider>
    );
  }
  const view = render(picker(true));
  return { ...fixture, onClose, setOpen: (open: boolean) => view.rerender(picker(open)) };
}

describe("ClimbingLogAttachment", () => {
  it.each([
    { nameKind: "null", recordedName: null },
    { nameKind: "empty", recordedName: "" },
    { nameKind: "whitespace", recordedName: " \t\n " },
  ])("uses an activity type title for a $nameKind recorded name", async ({ recordedName }) => {
    renderPicker({
      activities: [
        {
          id: "00000000-0000-4000-8000-000000000004",
          name: recordedName,
          activityType: "climbing",
          providerId: "garmin",
          startTime: "08:30",
        },
      ],
    });

    const choice = await screen.findByRole("radio", { name: "Climbing, 08:30, Garmin" });
    expect(within(choice).getByText("Climbing")).toBeTruthy();
    expect(within(choice).getByText("08:30 · Garmin")).toBeTruthy();
    fireEvent.click(choice);
    expect(
      screen
        .getByRole("button", { name: "Attach log to selected activity" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("refreshes a cached empty day when reopening the picker after activities sync", async () => {
    const fixture = renderPicker({ activities: [] }, []);
    await waitFor(() => expect(fixture.queryClient.isFetching()).toBe(0));
    expect(
      screen.getByText("No recorded climbing or hiking activities on 2026-10-11."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel attachment" }));
    fixture.setOpen(false);
    const requestsBeforeReopen = fixture.requests.length;
    fixture.setActivities(climbingAttachmentActivities);

    fixture.setOpen(true);

    expect(
      await screen.findByRole("radio", { name: "Evening bouldering, Climbing, 18:30, Garmin" }),
    ).toBeTruthy();
    expect(fixture.requests.length).toBeGreaterThan(requestsBeforeReopen);
    expect(fixture.requests.at(-1)).toEqual({
      path: "climbing.attachmentActivities",
      input: { date: "2026-10-11" },
    });
  });

  it("keeps cached activity choices visible while refreshing them on open", () => {
    const fixture = renderPicker({ loading: true }, climbingAttachmentActivities);
    expect(
      screen.getByRole("radio", { name: "Evening bouldering, Climbing, 18:30, Garmin" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(fixture.requests).toEqual([
      { path: "climbing.attachmentActivities", input: { date: "2026-10-11" } },
    ]);
  });

  it("requests the log's source date and offers recorded activities without attaching automatically", async () => {
    const fixture = renderPicker();

    expect(
      await screen.findByRole("radio", { name: "Evening bouldering, Climbing, 18:30, Garmin" }),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Hiking, 09:15, Apple Health" })).toBeTruthy();
    expect(screen.getByText("09:15 · Apple Health")).toBeTruthy();
    expect(screen.getByText("Climbing · 18:30 · Garmin")).toBeTruthy();
    expect(fixture.requests).toEqual([
      { path: "climbing.attachmentActivities", input: { date: "2026-10-11" } },
    ]);
    expect(
      screen
        .getByRole("button", { name: "Attach log to selected activity" })
        .hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel attachment" }));
    expect(fixture.onClose).toHaveBeenCalledOnce();
    expect(fixture.requests).toHaveLength(1);
  });

  it("attaches only the selected log and refreshes its map and activity views before closing", async () => {
    const fixture = renderPicker();
    const affectedKeys = [
      getQueryKey(trpc.activity.images, { id: "00000000-0000-4000-8000-000000000001" }, "query"),
      getQueryKey(trpc.climbing.locationMap),
      getQueryKey(
        trpc.climbing.activityLogEntries,
        { activityId: "00000000-0000-4000-8000-000000000001", responseVersion: 3 },
        "query",
      ),
      getQueryKey(
        trpc.climbing.unattachedClimbingLogEntries,
        { activityId: "00000000-0000-4000-8000-000000000001" },
        "query",
      ),
      getQueryKey(
        trpc.climbing.unattachedClimbingLogEntries,
        { activityId: "00000000-0000-4000-8000-000000000002", responseVersion: 3 },
        "query",
      ),
      getQueryKey(trpc.climbing.sessionSummary),
      getQueryKey(trpc.mobileDashboard.trainingV2),
      getQueryKey(trpc.climbing.strengths),
      getQueryKey(trpc.climbing.volumeByGrade),
      getQueryKey(trpc.activity.list),
      getQueryKey(trpc.calendar.weekList),
    ];
    for (const key of affectedKeys) fixture.queryClient.setQueryData(key, []);

    fireEvent.click(
      await screen.findByRole("radio", { name: "Evening bouldering, Climbing, 18:30, Garmin" }),
    );
    expect(
      screen
        .getByRole("radio", { name: "Evening bouldering, Climbing, 18:30, Garmin" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Attach log to selected activity" }));

    await waitFor(() => expect(fixture.onClose).toHaveBeenCalledOnce());
    expect(fixture.requests).toContainEqual({
      path: "climbing.attachClimbingLogEntry",
      input: {
        climbingLogEntryId: "00000000-0000-4000-8000-000000000003",
        activityId: "00000000-0000-4000-8000-000000000001",
      },
    });
    for (const key of affectedKeys) {
      expect(fixture.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("prevents repeated submission while attachment is pending", async () => {
    const fixture = renderPicker({ mutationPending: true });
    const choice = await screen.findByRole("radio", {
      name: "Evening bouldering, Climbing, 18:30, Garmin",
    });
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Attach log to selected activity" }));

    const submit = await screen.findByRole("button", { name: "Attaching log to activity" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(choice.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel attachment" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(submit);
    expect(
      fixture.requests.filter((request) => request.path === "climbing.attachClimbingLogEntry"),
    ).toHaveLength(1);
    expect(fixture.onClose).not.toHaveBeenCalled();
  });

  it("shows an actionable mutation error and keeps the selected activity available for retry", async () => {
    const fixture = renderPicker({
      mutationError: "This climbing log is already attached. Refresh the climbing map.",
    });
    fireEvent.click(
      await screen.findByRole("radio", { name: "Evening bouldering, Climbing, 18:30, Garmin" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach log to selected activity" }));

    expect(
      await screen.findByText("This climbing log is already attached. Refresh the climbing map."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Attach log to selected activity" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(fixture.onClose).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "This climbing log is already attached. Refresh the climbing map.",
      }),
    );
  });

  it("shows loading while same-day activities are being fetched", () => {
    renderPicker({ loading: true });
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(
      screen.queryByText("No recorded climbing or hiking activities on 2026-10-11."),
    ).toBeNull();
  });

  it("explains when no recorded climbing or hiking activities exist on the log day", async () => {
    const fixture = renderPicker({ activities: [] });
    expect(
      await screen.findByText("No recorded climbing or hiking activities on 2026-10-11."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Attach log to selected activity" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(fixture.requests).toHaveLength(1);
  });

  it("shows the specific activity-query error separately from an empty day", async () => {
    const fixture = renderPicker({
      queryError: "Activities are unavailable. Reconnect Garmin and retry.",
    });
    expect(
      await screen.findByText("Activities are unavailable. Reconnect Garmin and retry."),
    ).toBeTruthy();
    expect(
      screen.queryByText("No recorded climbing or hiking activities on 2026-10-11."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fixture.requests).toHaveLength(2));
    expect(fixture.requests[1]).toEqual({
      path: "climbing.attachmentActivities",
      input: { date: "2026-10-11" },
    });
  });
});
