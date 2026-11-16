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
  invalidations: new Set<string>(),
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
        images: {
          invalidate: () => {
            mocks.invalidations.add("images");
          },
        },
      },
      climbing: {
        activityLogEntries: {
          invalidate: () => {
            mocks.invalidations.add("activityLogEntries");
          },
        },
        sessionSummary: {
          invalidate: () => {
            mocks.invalidations.add("sessionSummary");
          },
        },
        volumeByGrade: {
          invalidate: () => {
            mocks.invalidations.add("volumeByGrade");
          },
        },
        strengths: {
          invalidate: () => {
            mocks.invalidations.add("strengths");
          },
        },
        unattachedClimbingLogEntries: {
          invalidate: () => {
            mocks.invalidations.add("suggestions");
          },
        },
      },
      mobileDashboard: {
        trainingV2: {
          invalidate: () => {
            mocks.invalidations.add("trainingV2");
          },
        },
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
  mocks.invalidations.clear();
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

it("keeps attachment errors per entry and preserves mobile invalidations", async () => {
  const { result } = renderHook(() => useActivityClimbing("activity-1", true));
  act(() => result.current.attachEntry("entry-1"));
  expect(result.current.attachmentStates["entry-1"]).toEqual({
    pending: false,
    error: "Attachment failed",
  });
  const success = mocks.successCallbacks.get("attach");
  if (!success) throw new Error("Expected mutation success callback");
  await act(async () => success(undefined, { activityId: "activity-1" }));
  expect([...mocks.invalidations]).toEqual([
    "images",
    "activityLogEntries",
    "sessionSummary",
    "trainingV2",
    "volumeByGrade",
    "strengths",
    "suggestions",
  ]);
});
