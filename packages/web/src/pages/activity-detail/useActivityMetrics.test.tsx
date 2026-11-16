// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  useAuth: vi.fn(() => ({ user: { id: "user-a" }, accountSessionOwnerNonce: "session-a" })),
  metricSources: vi.fn(),
  stream: vi.fn(),
  heartRateContext: vi.fn(),
  hrZones: vi.fn(),
  powerZones: vi.fn(),
  powerWork: vi.fn(),
}));

vi.mock("../../lib/auth-context.tsx", () => ({ useAuth: dependencies.useAuth }));
vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    activity: {
      metricSources: { useQuery: dependencies.metricSources },
      stream: { useQuery: dependencies.stream },
      heartRateContext: { useQuery: dependencies.heartRateContext },
      hrZones: { useQuery: dependencies.hrZones },
      powerZones: { useQuery: dependencies.powerZones },
      powerWork: { useQuery: dependencies.powerWork },
    },
  },
}));

import type { activityQueryPlaceholder } from "@dofek/training/activity-query-placeholder";
import type { ActivityMetricSources } from "../../../../server/src/contracts/activity-metric-sources.ts";
import { useActivityMetrics } from "./useActivityMetrics.ts";

function isPlaceholderCallback(
  value: unknown,
): value is ReturnType<typeof activityQueryPlaceholder> {
  return typeof value === "function";
}

const metricSources: ActivityMetricSources = [
  {
    key: "heartRate",
    label: "Heart Rate",
    defaultSourceId: "hr-a",
    sources: [
      {
        id: "hr-a",
        label: "Heart rate A",
        presentation: {
          displayName: "A",
          providerId: "whoop",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "hr-b",
        label: "Heart rate B",
        presentation: {
          displayName: "B",
          providerId: "garmin",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
  {
    key: "power",
    label: "Power",
    defaultSourceId: "power-a",
    sources: [
      {
        id: "power-a",
        label: "Power A",
        presentation: {
          displayName: "A",
          providerId: "wahoo",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "power-b",
        label: "Power B",
        presentation: {
          displayName: "B",
          providerId: "garmin",
          sourceName: null,
          attribution: null,
        },
      },
    ],
  },
];

function query(data: unknown, options: Record<string, unknown> = {}) {
  return {
    data,
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    ...options,
  };
}

describe("useActivityMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.useAuth.mockReturnValue({
      user: { id: "user-a" },
      accountSessionOwnerNonce: "session-a",
    });
    dependencies.metricSources.mockReturnValue(query(metricSources));
    dependencies.stream.mockReturnValue(query([{ power: 180, heartRate: 140 }]));
    dependencies.heartRateContext.mockReturnValue(
      query({ points: [], window: { startedAt: "2026-04-14T09:55:00Z", endedAt: null } }),
    );
    dependencies.hrZones.mockReturnValue(query([]));
    dependencies.powerZones.mockReturnValue(query(null));
    dependencies.powerWork.mockReturnValue(
      query({ workKilojoules: 120, coverage: { coveragePct: 100 } }),
    );
  });

  it("keeps picker selection immediate and preserves request gates, raw inputs and placeholder scope", () => {
    const { result } = renderHook(() =>
      useActivityMetrics("activity-a", { isCycling: true, isClimbing: true }),
    );
    expect(dependencies.stream).toHaveBeenLastCalledWith(
      { id: "activity-a", maxPoints: 500, sources: { heartRate: "hr-a", power: "power-a" } },
      expect.objectContaining({ placeholderData: expect.any(Function) }),
    );
    expect(dependencies.powerZones.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
    expect(dependencies.powerWork.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
    expect(dependencies.heartRateContext.mock.calls.at(-1)?.[1]).toMatchObject({ enabled: true });
    const placeholderValue = dependencies.stream.mock.calls.at(-1)?.[1].placeholderData;
    if (!isPlaceholderCallback(placeholderValue))
      throw new Error("Stream placeholder callback missing");
    const placeholder = placeholderValue;
    const previousData = [{ power: 100 }];
    expect(
      placeholder(previousData, {
        queryKey: [["activity", "stream"], { input: { id: "activity-a" } }],
      }),
    ).toBe(previousData);
    expect(
      placeholder(previousData, {
        queryKey: [["activity", "stream"], { input: { id: "activity-b" } }],
      }),
    ).toBeUndefined();

    act(() => result.current.sourceControls[0]?.onChange("hr-b"));
    expect(result.current.sourceControls[0]?.selectedId).toBe("hr-b");
    expect(dependencies.stream.mock.calls.at(-1)?.[0]).toEqual({
      id: "activity-a",
      maxPoints: 500,
      sources: { heartRate: "hr-b", power: "power-a" },
    });
  });

  it("keeps initial canonical source attribution unknown when metric metadata arrives", () => {
    let sourceResponse = query(undefined);
    let streamResponse = query([{ power: 180 }]);
    dependencies.metricSources.mockImplementation(() => sourceResponse);
    dependencies.stream.mockImplementation(() => streamResponse);
    const { result, rerender } = renderHook(() =>
      useActivityMetrics("activity-a", { isCycling: true, isClimbing: false }),
    );
    expect(result.current.attributionHints.stream.power).toBeUndefined();
    sourceResponse = query(metricSources);
    streamResponse = query([{ power: 180 }], { isPlaceholderData: true });
    rerender();
    expect(result.current.attributionHints.stream.power).toBe(
      "Showing previous readings; source unavailable",
    );
  });

  it("does not carry requested picker state into another authenticated session", () => {
    const { result, rerender } = renderHook(() =>
      useActivityMetrics("activity-a", { isCycling: true, isClimbing: false }),
    );
    act(() => result.current.sourceControls[0]?.onChange("hr-b"));
    expect(result.current.sourceControls[0]?.selectedId).toBe("hr-b");
    dependencies.useAuth.mockReturnValue({
      user: { id: "user-b" },
      accountSessionOwnerNonce: "session-b",
    });
    rerender();
    expect(result.current.sourceControls[0]?.selectedId).toBe("hr-a");
  });
});
