// @vitest-environment jsdom

import type { UseMutationOptions } from "@tanstack/react-query";
import {
  QueryClient,
  QueryClientProvider,
  useMutation as useTanstackMutation,
} from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
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
  errorCallbacks: new Map<
    string,
    (error: Error, input: { activityId: string; climbingLogEntryId: string }) => void
  >(),
  imagesInvalidate: vi.fn().mockResolvedValue(undefined),
  entriesInvalidate: vi.fn().mockResolvedValue(undefined),
  sessionSummaryInvalidate: vi.fn().mockResolvedValue(undefined),
  trainingInvalidate: vi.fn().mockResolvedValue(undefined),
  volumeInvalidate: vi.fn().mockResolvedValue(undefined),
  strengthsInvalidate: vi.fn().mockResolvedValue(undefined),
  attemptsInvalidate: vi.fn().mockResolvedValue(undefined),
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
        attemptIncrease: { invalidate: mocks.attemptsInvalidate },
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
  mocks.mutate.mockImplementation(() => undefined);
  mocks.useMutation.mockImplementation(
    (options: {
      onSuccess: (
        result: unknown,
        input: { activityId: string; climbingLogEntryId: string },
      ) => Promise<void>;
      onError: (error: Error, input: { activityId: string; climbingLogEntryId: string }) => void;
    }) => {
      mocks.successCallbacks.set("attach", options.onSuccess);
      mocks.errorCallbacks.set("attach", options.onError);
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
    mocks.attemptsInvalidate,
    mocks.suggestionsInvalidate,
    mocks.byIdInvalidate,
    mocks.streamInvalidate,
  ])
    invalidate.mockClear();
  mocks.successCallbacks.clear();
  mocks.errorCallbacks.clear();
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
  expect(result.current.attachmentStates["entry-1"]).toEqual({ pending: true, error: null });
  const onError = mocks.errorCallbacks.get("attach");
  if (!onError) throw new Error("Expected hook-level mutation error callback");
  act(() =>
    onError(new Error("Attachment failed"), {
      activityId: "activity-1",
      climbingLogEntryId: "entry-1",
    }),
  );
  expect(result.current.attachmentStates["entry-1"]).toEqual({
    pending: false,
    error: "Attachment failed",
  });
  const success = mocks.successCallbacks.get("attach");
  if (!success) throw new Error("Expected mutation success callback");
  await act(async () =>
    success(undefined, { activityId: "activity-1", climbingLogEntryId: "entry-1" }),
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
  expect(mocks.attemptsInvalidate).toHaveBeenCalledWith();
  expect(mocks.byIdInvalidate).not.toHaveBeenCalled();
  expect(mocks.streamInvalidate).not.toHaveBeenCalled();
});

it("tracks overlapping entry failure, retry, and independent completion through TanStack", async () => {
  type AttachInput = { activityId: string; climbingLogEntryId: string };
  type AttachOptions = UseMutationOptions<void, Error, AttachInput>;
  const requests: Array<{
    input: AttachInput;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  mocks.useMutation.mockImplementation((options: AttachOptions) =>
    useTanstackMutation({
      ...options,
      mutationFn: (input: AttachInput) =>
        new Promise<void>((resolve, reject) => requests.push({ input, resolve, reject })),
    }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useActivityClimbing("activity-1", true), { wrapper });

  act(() => result.current.attachEntry("entry-a"));
  act(() => result.current.attachEntry("entry-b"));
  await act(async () => Promise.resolve());
  expect(requests.map(({ input }) => input.climbingLogEntryId)).toEqual(["entry-a", "entry-b"]);
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: true, error: null },
    "entry-b": { pending: true, error: null },
  });

  await act(async () => requests[0]?.reject(new Error("Entry A failed")));
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: false, error: "Entry A failed" },
    "entry-b": { pending: true, error: null },
  });

  act(() => result.current.attachEntry("entry-a"));
  expect(result.current.attachmentStates["entry-a"]).toEqual({ pending: true, error: null });
  await act(async () => requests[1]?.resolve());
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: true, error: null },
    "entry-b": { pending: false, error: null },
  });
  await act(async () => requests[2]?.resolve());
  expect(result.current.attachmentStates).toMatchObject({
    "entry-a": { pending: false, error: null },
    "entry-b": { pending: false, error: null },
  });
  client.clear();
});
