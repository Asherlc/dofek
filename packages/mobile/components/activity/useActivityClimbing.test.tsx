// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { climbingLogEntryFixture } from "../../../server/src/repositories/climbing-test-helpers.ts";

const mocks = vi.hoisted(() => ({
  entriesQuery: vi.fn(),
  suggestionsQuery: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
  successCallbacks: new Map<
    string,
    (result: unknown, input: { activityId: string; climbingLogEntryId: string }) => Promise<void>
  >(),
  imagesInvalidate: vi.fn().mockResolvedValue(undefined),
  entriesInvalidate: vi.fn().mockResolvedValue(undefined),
  sessionSummaryInvalidate: vi.fn().mockResolvedValue(undefined),
  trainingInvalidate: vi.fn().mockResolvedValue(undefined),
  volumeInvalidate: vi.fn().mockResolvedValue(undefined),
  strengthsInvalidate: vi.fn().mockResolvedValue(undefined),
  suggestionsInvalidate: vi.fn().mockResolvedValue(undefined),
  byIdInvalidate: vi.fn().mockResolvedValue(undefined),
  streamInvalidate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/trpc", () => ({
  trpc: {
    climbing: {
      activityLogEntries: { useQuery: mocks.entriesQuery },
      unattachedClimbingLogEntries: { useQuery: mocks.suggestionsQuery },
      attachClimbingLogEntry: { useMutation: mocks.useMutation },
    },
    useUtils: () => ({
      activity: {
        images: { invalidate: mocks.imagesInvalidate },
        byId: { invalidate: mocks.byIdInvalidate },
        stream: { invalidate: mocks.streamInvalidate },
      },
      climbing: {
        activityLogEntries: { invalidate: mocks.entriesInvalidate },
        sessionSummary: { invalidate: mocks.sessionSummaryInvalidate },
        volumeByGrade: { invalidate: mocks.volumeInvalidate },
        strengths: { invalidate: mocks.strengthsInvalidate },
        unattachedClimbingLogEntries: { invalidate: mocks.suggestionsInvalidate },
      },
      mobileDashboard: {
        trainingV2: { invalidate: mocks.trainingInvalidate },
      },
    }),
  },
}));

import { useActivityClimbing } from "./useActivityClimbing";

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
  for (const invalidate of [
    mocks.imagesInvalidate,
    mocks.entriesInvalidate,
    mocks.sessionSummaryInvalidate,
    mocks.trainingInvalidate,
    mocks.volumeInvalidate,
    mocks.strengthsInvalidate,
    mocks.suggestionsInvalidate,
    mocks.byIdInvalidate,
    mocks.streamInvalidate,
  ])
    invalidate.mockClear();
  mocks.successCallbacks.clear();
});

it("gates both entry queries until a canonical activity ID is present", () => {
  renderHook(() => useActivityClimbing(undefined, true));
  expect(mocks.entriesQuery).toHaveBeenCalledWith(
    { activityId: "", responseVersion: 5 },
    expect.objectContaining({ enabled: false, select: expect.any(Function) }),
  );
  expect(mocks.suggestionsQuery).toHaveBeenCalledWith(
    { activityId: "", responseVersion: 5 },
    expect.objectContaining({ enabled: false, select: expect.any(Function) }),
  );
});

it("queries canonical activity log families with response version five and decodes selected rows", () => {
  const entry = climbingLogEntryFixture();
  mocks.entriesQuery.mockReturnValue({ data: [entry], isLoading: false, error: null });
  const { result } = renderHook(() => useActivityClimbing("activity-canonical", true));

  for (const query of [mocks.entriesQuery, mocks.suggestionsQuery]) {
    expect(query).toHaveBeenLastCalledWith(
      { activityId: "activity-canonical", responseVersion: 5 },
      expect.objectContaining({ enabled: true, select: expect.any(Function) }),
    );
  }
  const queryOptions = mocks.entriesQuery.mock.calls.at(-1)?.[1];
  const select =
    queryOptions && typeof queryOptions === "object" ? Reflect.get(queryOptions, "select") : null;
  if (typeof select !== "function") throw new Error("Missing climbing response decoder");
  expect(select([entry])).toEqual([entry]);
  expect(result.current.entries.data).toEqual([entry]);
});

it("keeps attachment errors per entry and preserves mobile invalidations", async () => {
  const { result } = renderHook(() => useActivityClimbing("activity-1", true));
  act(() => result.current.attachEntry("entry-1"));
  expect(result.current.attachmentStates["entry-1"]).toEqual({
    pending: false,
    error: "Attachment failed",
  });
  const success = mocks.successCallbacks.get("attach");
  if (!success) throw new Error("Expected mutation success callback");
  await act(async () =>
    success(undefined, { activityId: "activity-1", climbingLogEntryId: "entry-1" }),
  );
  expect(mocks.mutate).toHaveBeenCalledWith(
    { activityId: "activity-1", climbingLogEntryId: "entry-1" },
    expect.objectContaining({ onError: expect.any(Function), onSuccess: expect.any(Function) }),
  );
  expect(mocks.imagesInvalidate).toHaveBeenCalledWith({ id: "activity-1" });
  expect(mocks.entriesInvalidate).toHaveBeenCalledWith({
    activityId: "activity-1",
    responseVersion: 5,
  });
  expect(mocks.suggestionsInvalidate).toHaveBeenCalledWith({
    activityId: "activity-1",
    responseVersion: 5,
  });
  expect(mocks.sessionSummaryInvalidate).toHaveBeenCalledWith();
  expect(mocks.trainingInvalidate).toHaveBeenCalledWith();
  expect(mocks.volumeInvalidate).toHaveBeenCalledWith();
  expect(mocks.strengthsInvalidate).toHaveBeenCalledWith();
  expect(mocks.byIdInvalidate).not.toHaveBeenCalled();
  expect(mocks.streamInvalidate).not.toHaveBeenCalled();
});
