import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lockActivityGroups,
  reconcileActivityGroups,
} from "../../../../src/db/activity-group-reconciliation.ts";
import { markProviderActivityPresent } from "../../../../src/db/provider-activity-sync.ts";
import {
  createMetricStreamEvent,
  type MetricStreamEventV2,
} from "../../../../src/metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import { upsertHealthKitWorkouts } from "../routers/health-kit-sync-processors.ts";
import type { RunningStepSample, WorkoutSample } from "../routers/health-kit-sync-schemas.ts";
import { processRunningStepSamples } from "./health-kit-running-steps-repository.ts";

vi.mock("../routers/health-kit-sync-processors.ts", () => ({
  upsertHealthKitWorkouts: vi.fn().mockResolvedValue(1),
  appleHealthWorkoutExternalId: (uuid: string) => `hk:workout:${uuid}`,
}));
vi.mock("../../../../src/db/provider-activity-sync.ts", () => ({
  markProviderActivityPresent: vi.fn(),
}));
vi.mock("../../../../src/db/activity-group-reconciliation.ts", () => ({
  lockActivityGroups: vi.fn(),
  reconcileActivityGroups: vi.fn(),
}));
vi.mock("../../../../src/db/provider-data-deletion.ts", () => ({
  getProviderDataGenerations: async (
    _db: unknown,
    scopes: { userId: string; providerId: string }[],
  ) => ({
    operationRevision: "12345",
    generations: scopes.map((scope) => ({ ...scope, generation: 2 })),
  }),
}));
const userId = "00000000-0000-0000-0000-000000000001";
const run: WorkoutSample = {
  uuid: "00000000-0000-4000-8000-000000000201",
  workoutType: "37",
  startDate: "2026-10-20T10:00:00Z",
  endDate: "2026-10-20T11:00:00Z",
  duration: 3600,
  totalDistance: null,
  sourceName: "Watch",
  sourceBundle: "watch",
};
const sample: RunningStepSample = {
  uuid: "00000000-0000-4000-8000-000000000202",
  type: "HKQuantityTypeIdentifierStepCount",
  unit: "count",
  value: 3.5,
  startDate: "2026-10-20T10:00:00.125Z",
  endDate: "2026-10-20T10:00:01.375Z",
  sourceName: "Watch",
  sourceBundle: "watch",
  workoutUuids: [run.uuid],
};
function database() {
  const db = {
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  db.transaction.mockImplementation(async (work) => work(db));
  return db;
}
describe("processRunningStepSamples", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(upsertHealthKitWorkouts).mockResolvedValue(1);
    vi.mocked(reconcileActivityGroups).mockResolvedValue(undefined);
  });
  it("locks, upserts, restores and reconciles on the inner transaction before publishing", async () => {
    const outer = database();
    const inner = database();
    const order: string[] = [];
    outer.transaction.mockImplementation(async (work) => {
      order.push("begin");
      await work(inner);
      order.push("commit");
    });
    vi.mocked(lockActivityGroups).mockImplementation(async (db, owner) => {
      expect(db).toBe(inner);
      expect(owner).toBe(userId);
      order.push("lock");
    });
    vi.mocked(upsertHealthKitWorkouts).mockImplementation(async (db, owner, workouts) => {
      expect(db).toBe(inner);
      expect(owner).toBe(userId);
      expect(workouts).toEqual([run]);
      order.push("upsert");
      return 1;
    });
    vi.mocked(markProviderActivityPresent).mockImplementation(async (db, identity) => {
      expect(db).toBe(inner);
      expect(identity).toEqual({
        userId,
        providerId: "apple_health",
        externalId: `hk:workout:${run.uuid}`,
      });
      order.push("present");
    });
    vi.mocked(reconcileActivityGroups).mockImplementation(async (db, owner) => {
      expect(db).toBe(inner);
      expect(owner).toBe(userId);
      order.push("reconcile");
    });
    const publisher: MetricStreamEventPublisher = {
      publishRows: async (rows, options) => {
        order.push("publish");
        return rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
      },
    };
    await processRunningStepSamples(outer, userId, [run], [sample], publisher);
    expect(order).toEqual([
      "begin",
      "lock",
      "upsert",
      "present",
      "reconcile",
      "commit",
      "begin",
      "publish",
      "commit",
    ]);
  });
  it("propagates reconciliation failure without publishing raw observations", async () => {
    const failure = new Error("Grouping rejected");
    vi.mocked(reconcileActivityGroups).mockRejectedValueOnce(failure);
    const publisher: MetricStreamEventPublisher = { publishRows: vi.fn().mockResolvedValue([]) };
    await expect(
      processRunningStepSamples(database(), userId, [run], [sample], publisher),
    ).rejects.toBe(failure);
    expect(publisher.publishRows).not.toHaveBeenCalled();
  });
  it("merges all associations once and retains distinct interval ends and source identities", async () => {
    const secondRun = { ...run, uuid: "00000000-0000-4000-8000-000000000203" };
    const events: MetricStreamEventV2[] = [];
    const publisher: MetricStreamEventPublisher = {
      publishRows: async (rows, options) => {
        const batch = rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
        events.push(...batch);
        return batch;
      },
    };
    const count = await processRunningStepSamples(
      database(),
      userId,
      [run, secondRun],
      [
        sample,
        { ...sample, sourceName: "Localized Watch", workoutUuids: [secondRun.uuid] },
        { ...sample, endDate: "2026-10-20T10:00:02.375Z" },
        { ...sample, sourceBundle: "phone" },
      ],
      publisher,
    );
    expect(count).toBe(3);
    expect(new Set(events.map((event) => event.id)).size).toBe(3);
    expect(events[0]).toMatchObject({
      scalar: 3.5,
      deviceId: "Localized Watch",
      channel: "step_count",
      externalId: `hk:${sample.uuid}`,
      generation: 2,
      metadata: {
        interval_end: sample.endDate,
        source_bundle: "watch",
        workout_uuids: [run.uuid, secondRun.uuid],
      },
    });
  });
  it("publishes the same observation identity after a source display rename", async () => {
    const secondRun = { ...run, uuid: "00000000-0000-4000-8000-000000000203" };
    const versions: MetricStreamEventV2[] = [];
    const publisher: MetricStreamEventPublisher = {
      publishRows: async (rows, options) => {
        const events = rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
        versions.push(...events);
        return events;
      },
    };
    const associatedChild = { ...sample, workoutUuids: [run.uuid, secondRun.uuid] };
    expect(
      await processRunningStepSamples(
        database(),
        userId,
        [run, secondRun],
        [associatedChild],
        publisher,
      ),
    ).toBe(1);
    expect(
      await processRunningStepSamples(
        database(),
        userId,
        [run, secondRun],
        [{ ...associatedChild, sourceName: "Localized Watch" }],
        publisher,
      ),
    ).toBe(1);
    expect(versions).toHaveLength(2);
    expect(versions[1]?.id).toBe(versions[0]?.id);
    expect(versions[1]).toMatchObject({
      deviceId: "Localized Watch",
      scalar: 3.5,
      metadata: { source_bundle: "watch", workout_uuids: [run.uuid, secondRun.uuid] },
    });
  });

  it("rejects conflicting values for one child before changing workout presence", async () => {
    const publisher: MetricStreamEventPublisher = { publishRows: vi.fn() };
    await expect(
      processRunningStepSamples(
        database(),
        userId,
        [run],
        [sample, { ...sample, value: 99 }],
        publisher,
      ),
    ).rejects.toThrow(/conflicting counts/i);
    expect(upsertHealthKitWorkouts).not.toHaveBeenCalled();
  });
});
