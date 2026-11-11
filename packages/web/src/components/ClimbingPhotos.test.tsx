// @vitest-environment jsdom

import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getQueryKey } from "@trpc/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { trpc } from "../lib/trpc.ts";
import { activityPhotoFixture } from "./ActivityPhoto.fixtures.ts";
import { ClimbingPhotos } from "./ClimbingPhotos.tsx";
import {
  type ClimbingPhotosScenario,
  createClimbingPhotosFixture,
} from "./climbing-photos-test-helpers.ts";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
type Gallery = NonNullable<ReturnType<typeof trpc.climbing.images.useQuery>["data"]>;
const fixtures: ReturnType<typeof createClimbingPhotosFixture>[] = [];
const key = getQueryKey(trpc.climbing.images, { id: "log-1" }, "query");
const photo = {
  ...activityPhotoFixture,
  sources: [
    {
      activityId: null,
      climbingLogEntryId: "log-1",
      providerId: "kaya",
      sourceId: "ascent-1",
      kind: "photo",
      caption: "The arete",
      position: 0,
    },
  ],
};
function renderPhotos(scenario: ClimbingPhotosScenario, cachedData?: Gallery) {
  const fixture = createClimbingPhotosFixture(scenario);
  fixtures.push(fixture);
  if (cachedData) fixture.queryClient.setQueryData(key, cachedData);
  const view = render(
    <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
      <QueryClientProvider client={fixture.queryClient}>
        <ClimbingPhotos id="log-1" />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { ...fixture, ...view };
}
afterEach(() => {
  cleanup();
  for (const fixture of fixtures) fixture.queryClient.clear();
  fixtures.length = 0;
});

it("loads private ascent photos, opens the full viewer, and restores thumbnail focus on close", async () => {
  const fixture = renderPhotos("stored");
  const thumbnail = await screen.findByRole("button", { name: "Enlarge The arete" });
  const query = fixture.queryClient.getQueryCache().find({ queryKey: key });
  expect(query?.options).toMatchObject(ACTIVITY_IMAGES_QUERY_OPTIONS);
  thumbnail.focus();
  fireEvent.click(thumbnail);
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByText("Kaya")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(thumbnail).toHaveFocus();
});
it("shows loading before the gallery first responds", () => {
  renderPhotos("loading");
  expect(screen.getByText(/Loading/)).toBeVisible();
  expect(screen.queryByText("Ascent photos are being downloaded…")).toBeNull();
});
it("shows pending acquisition after discovery reports work", async () => {
  renderPhotos("pending");
  expect(await screen.findByText("Ascent photos are being downloaded…")).toBeVisible();
  expect(screen.queryByText(/Loading/)).toBeNull();
});
it("omits the gallery after a completed empty response", async () => {
  const fixture = renderPhotos("empty");
  await waitFor(() => expect(fixture.queryClient.getQueryState(key)?.status).toBe("success"));
  expect(fixture.container.textContent).toBe("");
});
it("shows the server error and checks again when the user refreshes photos", async () => {
  const fixture = renderPhotos("error");
  expect(await screen.findByText("Reconnect to load ascent photos.")).toBeVisible();
  const previousError = fixture.queryClient.getQueryState(key)?.error;
  fireEvent.click(screen.getByRole("button", { name: "Refresh photos" }));
  await waitFor(() => {
    expect(fixture.queryClient.getQueryState(key)?.error).not.toBe(previousError);
    expect(screen.getByRole("button", { name: "Refresh photos" })).toBeEnabled();
  });
  expect(screen.getByText("Reconnect to load ascent photos.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Enlarge The arete" })).toBeNull();
});
it("retains cached photos after failed refreshes and keeps the viewer usable after another refresh", async () => {
  const fixture = renderPhotos("refresh-error");
  expect(await screen.findByText("Reconnect to load ascent photos.")).toBeVisible();
  const previousError = fixture.queryClient.getQueryState(key)?.error;
  const thumbnail = screen.getByRole("button", { name: "Enlarge The arete" });
  expect(thumbnail).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Refresh photos" }));
  await waitFor(() => {
    expect(fixture.queryClient.getQueryState(key)?.error).not.toBe(previousError);
    expect(screen.getByRole("button", { name: "Refresh photos" })).toBeEnabled();
  });
  fireEvent.click(thumbnail);
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByText("Kaya")).toBeVisible();
});
it("surfaces terminal acquisition failure when no stored photo is available", async () => {
  renderPhotos("terminal-error");
  expect(
    await screen.findByText(
      "An ascent photo could not be downloaded. Refresh photos to check its status.",
    ),
  ).toBeVisible();
});
it("reports incomplete discovery with no stored photos", async () => {
  renderPhotos("incomplete");
  expect(
    await screen.findByText(
      "KAYA returned incomplete photo information. Sync KAYA to check again.",
    ),
  ).toBeVisible();
});
it("retains stored photos when discovery is incomplete", async () => {
  renderPhotos("incomplete-stored");
  expect(
    await screen.findByText(
      "KAYA returned incomplete photo information. Sync KAYA to check again.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Enlarge The arete" }));
  expect(screen.getByRole("dialog")).toBeVisible();
});
it.each([false, true])(
  "reports cached failed discovery while refreshing, retaining stored photos: %s",
  async (stored) => {
    renderPhotos("loading", {
      images: stored ? [photo] : [],
      acquisition: [],
      coverage: [
        {
          activityId: null,
          climbingLogEntryId: "log-1",
          providerId: "kaya",
          coverage: "failed",
          reason: "invalid_kaya_ascent_photo",
          expectedCount: null,
        },
      ],
    });
    expect(
      await screen.findByText(
        "KAYA returned incomplete photo information. Sync KAYA to check again.",
      ),
    ).toBeVisible();
    if (stored) expect(screen.getByRole("button", { name: "Enlarge The arete" })).toBeVisible();
    else expect(screen.queryByRole("button", { name: "Enlarge The arete" })).toBeNull();
  },
);
it("prioritizes a refresh error over cached incomplete discovery", async () => {
  renderPhotos("refresh-error", {
    images: [photo],
    acquisition: [],
    coverage: [
      {
        activityId: null,
        climbingLogEntryId: "log-1",
        providerId: "kaya",
        coverage: "partial",
        reason: "invalid_kaya_ascent_photo",
        expectedCount: null,
      },
    ],
  });
  expect(await screen.findByText("Reconnect to load ascent photos.")).toBeVisible();
  expect(
    screen.queryByText("KAYA returned incomplete photo information. Sync KAYA to check again."),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Enlarge The arete" })).toBeVisible();
});
