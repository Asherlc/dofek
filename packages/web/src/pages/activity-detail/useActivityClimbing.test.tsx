// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entriesQuery: vi.fn(),
  suggestionsQuery: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
  successCallbacks: new Map<
    string,
    (result: unknown, input: { activityId: string }) => Promise<void>
  >(),
  imagesInvalidate: vi.fn(),
  entriesInvalidate: vi.fn(),
  suggestionsInvalidate: vi.fn(),
  sessionSummaryInvalidate: vi.fn(),
  gradeProgressionInvalidate: vi.fn(),
  strengthsInvalidate: vi.fn(),
  volumeByGradeInvalidate: vi.fn(),
  activityByIdInvalidate: vi.fn(),
  streamInvalidate: vi.fn(),
}));
vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    climbing: {
      activityLogEntries: { useQuery: mocks.entriesQuery },
      unattachedClimbingLogEntries: { useQuery: mocks.suggestionsQuery },
      attachClimbingLogEntry: { useMutation: mocks.useMutation },
    },
    useUtils: () => ({
      climbing: {
        activityLogEntries: { invalidate: mocks.entriesInvalidate },
        sessionSummary: { invalidate: mocks.sessionSummaryInvalidate },
        gradeProgressionV2: { invalidate: mocks.gradeProgressionInvalidate },
        volumeByGrade: { invalidate: mocks.volumeByGradeInvalidate },
        strengths: { invalidate: mocks.strengthsInvalidate },
        unattachedClimbingLogEntries: { invalidate: mocks.suggestionsInvalidate },
      },
      activity: {
        images: { invalidate: mocks.imagesInvalidate },
        byId: { invalidate: mocks.activityByIdInvalidate },
        stream: { invalidate: mocks.streamInvalidate },
      },
    }),
  },
}));

import { climbingLogEntryFixture } from "../../../../server/src/repositories/climbing-test-helpers.ts";
import { useActivityClimbing } from "./useActivityClimbing.ts";

beforeEach(() => {
  mocks.entriesQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mocks.suggestionsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mocks.mutate.mockImplementation(
    (_input: unknown, callbacks: { onError: (error: Error) => void }) => {
      callbacks.onError(new Error("Attachment failed"));
    },
  );
  mocks.useMutation.mockImplementation(
    (options: { onSuccess: (result: unknown, input: { activityId: string }) => Promise<void> }) => {
      mocks.successCallbacks.set("attach", options.onSuccess);
      return { mutate: mocks.mutate };
    },
  );
  vi.clearAllMocks();
  mocks.successCallbacks.clear();
});

it("owns exact enabled query inputs, decoding and selected-entry details", () => {
  const entry = climbingLogEntryFixture({
    id: "20000000-0000-4000-8000-000000000111",
    title: "The Corner",
  });
  mocks.entriesQuery.mockReturnValue({ data: [entry], isLoading: false, error: null });
  const { result } = renderHook(() => useActivityClimbing("activity-1", true));
  expect(mocks.entriesQuery).toHaveBeenCalledWith(
    { activityId: "activity-1", responseVersion: 5 },
    expect.objectContaining({ enabled: true, select: expect.any(Function) }),
  );
  expect(mocks.suggestionsQuery).toHaveBeenCalledWith(
    { activityId: "activity-1", responseVersion: 5 },
    expect.objectContaining({ enabled: true, select: expect.any(Function) }),
  );
  expect(result.current.selectedEntry).toBeUndefined();
  expect(result.current.loading).toBe(false);
  const selectEntries = mocks.entriesQuery.mock.calls[0]?.[1]?.select;
  expect(typeof selectEntries).toBe("function");
  expect(selectEntries?.([entry])).toEqual([entry]);
  act(() => result.current.setSelectedEntryId(entry.id));
  expect(result.current.selectedEntry).toBe(entry);
});

it("keeps both climbing queries disabled outside climbing activities", () => {
  renderHook(() => useActivityClimbing("activity-1", false));
  expect(mocks.entriesQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
  expect(mocks.suggestionsQuery.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: false });
});

it("refreshes selected details, locations, and numbered markers from current query data", () => {
  const firstSuggestion = climbingLogEntryFixture({
    id: "suggestion-first",
    title: "First suggestion",
    mapLocation: {
      coordinates: { latitude: 1, longitude: -121 },
      scope: "climb",
      objectId: "climb-first",
      providerId: "mountain-project",
      name: "First suggestion",
    },
  });
  const refreshedEntry = climbingLogEntryFixture({
    id: "attached-refreshed",
    title: "Refreshed attached climb",
    mapLocation: {
      coordinates: { latitude: 0, longitude: -122 },
      scope: "climb",
      objectId: "climb-refreshed",
      providerId: "kaya",
      name: "Refreshed attached climb",
    },
  });
  const refreshedSuggestion = climbingLogEntryFixture({
    id: "suggestion-refreshed",
    title: "Refreshed suggestion",
    mapLocation: {
      coordinates: { latitude: 2, longitude: -123 },
      scope: "area",
      objectId: "area-refreshed",
      providerId: "openbeta",
      name: "Refreshed area",
    },
  });
  let entriesResult: {
    data: ReturnType<typeof climbingLogEntryFixture>[] | undefined;
    isLoading: boolean;
    error: Error | null;
  } = { data: undefined, isLoading: true, error: null };
  let suggestionsResult = { data: [firstSuggestion], isLoading: false, error: null };
  mocks.entriesQuery.mockImplementation(() => entriesResult);
  mocks.suggestionsQuery.mockImplementation(() => suggestionsResult);
  const { result, rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => useActivityClimbing("activity-1", enabled),
    { initialProps: { enabled: true } },
  );

  expect(result.current.markers).toMatchObject([
    { entryId: "suggestion-first", entryNumber: 1, location: firstSuggestion.mapLocation },
  ]);
  expect(result.current.locations).toMatchObject({
    "suggestion-first": firstSuggestion.mapLocation,
  });
  act(() => result.current.setSelectedEntryId(firstSuggestion.id));
  expect(result.current.selectedEntry).toBe(firstSuggestion);

  entriesResult = { data: [refreshedEntry], isLoading: false, error: null };
  suggestionsResult = { data: [refreshedSuggestion], isLoading: false, error: null };
  rerender({ enabled: true });
  expect(result.current.selectedEntry).toBeUndefined();
  act(() => result.current.setSelectedEntryId(refreshedEntry.id));
  expect(result.current.selectedEntry).toBe(refreshedEntry);
  expect(result.current.locations).toMatchObject({
    "attached-refreshed": refreshedEntry.mapLocation,
    "suggestion-refreshed": refreshedSuggestion.mapLocation,
  });
  expect(result.current.markers).toMatchObject([
    { entryId: "attached-refreshed", entryNumber: 1, location: refreshedEntry.mapLocation },
    { entryId: "suggestion-refreshed", entryNumber: 2, location: refreshedSuggestion.mapLocation },
  ]);

  rerender({ enabled: false });
  expect(result.current.markers).toEqual([]);
  expect(result.current.locations["suggestion-refreshed"]).toEqual(refreshedSuggestion.mapLocation);
  rerender({ enabled: true });
  expect(result.current.markers[0]).toMatchObject({
    entryId: "attached-refreshed",
    entryNumber: 1,
  });
});

it.each([
  { data: undefined, isLoading: true, expectedLoading: true },
  { data: [], isLoading: true, expectedLoading: false },
  { data: undefined, isLoading: false, expectedLoading: false },
])(
  "reports initial attached loading only without cached data: %o",
  ({ data, isLoading, expectedLoading }) => {
    mocks.entriesQuery.mockReturnValue({ data, isLoading, error: null });
    const { result } = renderHook(() => useActivityClimbing("activity-1", true));
    expect(result.current.loading).toBe(expectedLoading);
  },
);

it("keeps attachment errors per entry and invalidates the targeted web query families", async () => {
  const { result } = renderHook(() => useActivityClimbing("activity-1", true));
  act(() => result.current.attachEntry("entry-1"));
  expect(mocks.mutate).toHaveBeenCalledWith(
    { activityId: "activity-1", climbingLogEntryId: "entry-1" },
    expect.objectContaining({ onError: expect.any(Function), onSuccess: expect.any(Function) }),
  );
  expect(result.current.attachmentStates["entry-1"]).toEqual({
    pending: false,
    error: "Attachment failed",
  });
  const success = mocks.successCallbacks.get("attach");
  if (!success) throw new Error("Expected mutation success callback");
  await act(async () => success(undefined, { activityId: "activity-1" }));
  expect(mocks.imagesInvalidate).toHaveBeenCalledOnce();
  expect(mocks.imagesInvalidate).toHaveBeenCalledWith({ id: "activity-1" });
  expect(mocks.entriesInvalidate).toHaveBeenCalledOnce();
  expect(mocks.entriesInvalidate).toHaveBeenCalledWith({
    activityId: "activity-1",
    responseVersion: 5,
  });
  expect(mocks.suggestionsInvalidate).toHaveBeenCalledOnce();
  expect(mocks.suggestionsInvalidate).toHaveBeenCalledWith({
    activityId: "activity-1",
    responseVersion: 5,
  });
  for (const invalidate of [
    mocks.sessionSummaryInvalidate,
    mocks.gradeProgressionInvalidate,
    mocks.volumeByGradeInvalidate,
    mocks.strengthsInvalidate,
  ]) {
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith();
  }
  expect(mocks.activityByIdInvalidate).not.toHaveBeenCalled();
  expect(mocks.streamInvalidate).not.toHaveBeenCalled();
});

it("keeps per-entry pending, error, retry, and success state through actual mutation callbacks", () => {
  const perCallOptions: unknown[] = [];
  mocks.mutate.mockImplementation((_input, options) => {
    perCallOptions.push(options);
  });
  const { result } = renderHook(() => useActivityClimbing("activity-1", true));

  act(() => result.current.attachEntry("entry-a"));
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: true, error: null },
  });
  act(() => result.current.attachEntry("entry-b"));
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: true, error: null },
    "entry-b": { pending: true, error: null },
  });

  const firstOptions = perCallOptions[0];
  if (!firstOptions || typeof firstOptions !== "object")
    throw new Error("Expected first mutation callback options");
  const firstError = Reflect.get(firstOptions, "onError");
  if (typeof firstError !== "function") throw new Error("Expected first attachment error callback");
  act(() => firstError(new Error("Entry A failed")));
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: false, error: "Entry A failed" },
    "entry-b": { pending: true, error: null },
  });

  act(() => result.current.attachEntry("entry-a"));
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: true, error: null },
    "entry-b": { pending: true, error: null },
  });
  const secondOptions = perCallOptions[1];
  if (!secondOptions || typeof secondOptions !== "object")
    throw new Error("Expected second mutation callback options");
  const secondSuccess = Reflect.get(secondOptions, "onSuccess");
  if (typeof secondSuccess !== "function") throw new Error("Expected entry B success callback");
  act(() => secondSuccess());
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: true, error: null },
    "entry-b": { pending: false, error: null },
  });

  const retryOptions = perCallOptions[2];
  if (!retryOptions || typeof retryOptions !== "object")
    throw new Error("Expected retry mutation callback options");
  const retrySuccess = Reflect.get(retryOptions, "onSuccess");
  if (typeof retrySuccess !== "function") throw new Error("Expected entry A retry callback");
  act(() => retrySuccess());
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: false, error: null },
    "entry-b": { pending: false, error: null },
  });
});
