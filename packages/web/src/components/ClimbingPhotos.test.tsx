// @vitest-environment jsdom

import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { activityPhotoFixture } from "./ActivityPhoto.fixtures.ts";
import { ClimbingPhotos } from "./ClimbingPhotos";

const { useQuery, retry } = vi.hoisted(() => ({ useQuery: vi.fn(), retry: vi.fn() }));
vi.mock("../lib/trpc.ts", () => ({ trpc: { climbing: { images: { useQuery } } } }));
vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
const photo = {
  ...activityPhotoFixture,
  sources: [
    {
      ...activityPhotoFixture.sources[0],
      activityId: null,
      climbingLogEntryId: "log-1",
      providerId: "kaya",
      caption: "The arete",
    },
  ],
};
beforeEach(() => {
  retry.mockReset();
  useQuery.mockReturnValue({
    data: { images: [photo], acquisition: [], coverage: [] },
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: retry,
  });
});
it("requests ascent photos using the private gallery renewal policy and opens the full viewer", () => {
  render(<ClimbingPhotos id="log-1" />);
  expect(useQuery).toHaveBeenCalledWith({ id: "log-1" }, ACTIVITY_IMAGES_QUERY_OPTIONS);
  fireEvent.click(screen.getByRole("button", { name: "Enlarge The arete" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("Kaya")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("shows initial loading and pending acquisition separately from completed empty results", () => {
  useQuery.mockReturnValue({ isLoading: true, isFetching: true, error: null, refetch: retry });
  const view = render(<ClimbingPhotos id="log-1" />);
  expect(screen.getByText(/Loading/)).toBeTruthy();
  useQuery.mockReturnValue({
    data: { coverage: [], images: [], acquisition: [{ state: "pending", errorCode: null }] },
    isLoading: false,
    error: null,
    refetch: retry,
  });
  view.rerender(<ClimbingPhotos id="log-1" />);
  expect(screen.getByText("Ascent photos are being downloaded…")).toBeTruthy();
  useQuery.mockReturnValue({
    data: { images: [], acquisition: [], coverage: [] },
    isLoading: false,
    error: null,
    refetch: retry,
  });
  view.rerender(<ClimbingPhotos id="log-1" />);
  expect(view.container.textContent).toBe("");
});
it("retains stored photos during failed refreshes and retries the query", () => {
  useQuery.mockReturnValue({
    data: { images: [photo], acquisition: [], coverage: [] },
    isLoading: false,
    isFetching: false,
    error: new Error("Reconnect to load ascent photos."),
    refetch: retry,
  });
  render(<ClimbingPhotos id="log-1" />);
  expect(screen.getByRole("button", { name: "Enlarge The arete" })).toBeTruthy();
  expect(screen.getByText("Reconnect to load ascent photos.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh photos" }));
  expect(retry).toHaveBeenCalledOnce();
});
it("surfaces terminal acquisition failure when no stored photo is available", () => {
  useQuery.mockReturnValue({
    data: {
      coverage: [],
      images: [],
      acquisition: [{ state: "terminal_failure", errorCode: "invalid_image" }],
    },
    error: null,
    refetch: retry,
  });
  render(<ClimbingPhotos id="log-1" />);
  expect(
    screen.getByText(
      "An ascent photo could not be downloaded. Refresh photos to check its status.",
    ),
  ).toBeTruthy();
});

it.each(["partial", "failed"])("reports %s discovery with no stored photos", (coverage) => {
  useQuery.mockReturnValue({
    data: {
      images: [],
      acquisition: [],
      coverage: [{ coverage, reason: "invalid_kaya_ascent_photo" }],
    },
    error: null,
    refetch: retry,
  });
  render(<ClimbingPhotos id="log-1" />);
  expect(
    screen.getByText("KAYA returned incomplete photo information. Sync KAYA to check again."),
  ).toBeTruthy();
});
it.each(["partial", "failed"])("retains stored photos when discovery is %s", (coverage) => {
  useQuery.mockReturnValue({
    data: {
      images: [photo],
      acquisition: [],
      coverage: [{ coverage, reason: "invalid_kaya_ascent_photo" }],
    },
    error: null,
    refetch: retry,
  });
  render(<ClimbingPhotos id="log-1" />);
  expect(
    screen.getByText("KAYA returned incomplete photo information. Sync KAYA to check again."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Enlarge The arete" })).toBeTruthy();
});
it("prioritizes the query error over stale incomplete discovery", () => {
  useQuery.mockReturnValue({
    data: { images: [photo], acquisition: [], coverage: [{ coverage: "partial" }] },
    error: new Error("Photo access denied."),
    refetch: retry,
  });
  render(<ClimbingPhotos id="log-1" />);
  expect(screen.getByText("Photo access denied.")).toBeTruthy();
});
