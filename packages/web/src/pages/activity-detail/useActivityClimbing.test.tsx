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
