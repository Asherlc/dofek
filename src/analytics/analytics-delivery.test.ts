import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/index.ts";
import { sourceOwner } from "../metric-stream/test-helpers.ts";
import { coordinateAnalyticsDeliveryGroup } from "./analytics-delivery.ts";
import {
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import { analyticsPosition } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  claim: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
}));
vi.mock("./analytics-work-store.ts", () => ({
  loadAnalyticsStreamState: mocks.load,
  claimAnalyticsStream: mocks.claim,
  beginAnalyticsDeliveryGroup: mocks.begin,
  completeAnalyticsDeliveryGroup: mocks.complete,
}));
vi.mock("./analytics-query-owner.ts", () => ({
  ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
  withAnalyticsQueryOwner: mocks.write,
  withAnalyticsReceiptQueryOwner: mocks.read,
}));
const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());
const stream = { transport: "pulsar" as const, epoch: "epoch", topic: "sensor", partition: -1 };
const positions = [1n, 2n].map((entry) => analyticsPosition(stream, entry));
const trace: string[] = [];
const { owner } = sourceOwner();
const transaction = database;
beforeEach(() => {
  vi.resetAllMocks();
  trace.length = 0;
  vi.spyOn(database, "execute").mockImplementation(async () => {
    trace.push("guard");
    return [];
  });
  vi.spyOn(database, "transaction").mockImplementation(async (work) => {
    trace.push("transaction");
    const result = await work(transaction);
    trace.push("release");
    return result;
  });
  mocks.load.mockResolvedValue(null);
  mocks.write.mockImplementation(async (_db, _ch, _input, work) => work(owner));
  mocks.read.mockImplementation(async (_db, _ch, _input, work) => work(owner));
  mocks.claim.mockResolvedValue(undefined);
  mocks.begin.mockResolvedValue(undefined);
  mocks.complete.mockImplementation(async () => {
    trace.push("frontier");
  });
  owner.reserveIngestionThrough = vi.fn(async () => {
    trace.push("reserve");
  });
  owner.reuseIngestionReservation = vi.fn(async () => {
    trace.push("reuse");
  });
});
afterEach(() => vi.restoreAllMocks());
function input() {
  return {
    positions,
    maximum: 500,
    userIds: ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"],
    assertActive: vi.fn(async () => undefined),
    publish: vi.fn(async () => {
      trace.push("raw");
    }),
  };
}
describe("raw delivery coordination", () => {
  it("holds sorted user guards through raw publication and durable frontier completion", async () => {
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request);
    expect(trace).toEqual([
      "reserve",
      "transaction",
      "guard",
      "guard",
      "guard",
      "raw",
      "frontier",
      "release",
    ]);
    expect(request.publish).toHaveBeenCalledWith(
      owner,
      positions,
      ["2026-11-03T01:00:00.123456Z", "2026-11-03T01:00:00.123457Z"],
      new Set(),
    );
    expect(transaction.execute).toHaveBeenCalledTimes(3);
    expect(mocks.complete).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ positions }),
    );
  });
  it("leaves the frontier pending when raw publication fails", async () => {
    const request = input();
    request.publish.mockRejectedValue(new Error("raw insert failed"));
    await expect(
      coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request),
    ).rejects.toThrow("raw insert failed");
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("reuses the original pending timestamp reservation after a later owner timestamp", async () => {
    const group = {
      ...describeAnalyticsDeliveryGroup(positions, 500),
      ingestedAt: "2026-11-01T00:00:00.000001Z",
      intentId: analyticsDeliveryGroupIntentId(describeAnalyticsDeliveryGroup(positions, 500)),
    };
    mocks.load.mockResolvedValue({ owner_id: null, processed: null, pendingGroup: group });
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request);
    expect(owner.reuseIngestionReservation).toHaveBeenCalledWith(group);
    expect(owner.reserveIngestionThrough).not.toHaveBeenCalled();
    expect(request.publish).toHaveBeenCalledWith(
      owner,
      positions,
      ["2026-11-01T00:00:00.000001Z", "2026-11-01T00:00:00.000002Z"],
      new Set(),
    );
  });
  it("passes active and retained PG fences to publication while keeping the group frontier ordered", async () => {
    const erased = input().userIds[0];
    vi.mocked(transaction.execute)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ user_id: erased }]);
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request);
    expect(request.publish).toHaveBeenCalledWith(
      owner,
      positions,
      expect.any(Array),
      new Set([erased]),
    );
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("uses the committed PG frontier to acknowledge covered replay without raw publication", async () => {
    const completedGroup = {
      ...describeAnalyticsDeliveryGroup(positions, 500),
      ingestedAt: owner.ingestedAt,
      intentId: analyticsDeliveryGroupIntentId(describeAnalyticsDeliveryGroup(positions, 500)),
    };
    mocks.load.mockResolvedValue({ processed: positions[1], completedGroup });
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request);
    expect(request.publish).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("fails when a processed frontier no longer covers the replayed group", async () => {
    mocks.load
      .mockResolvedValueOnce({
        processed: positions[1],
        completedGroup: {
          ...describeAnalyticsDeliveryGroup(positions, 500),
          ingestedAt: owner.ingestedAt,
          intentId: analyticsDeliveryGroupIntentId(describeAnalyticsDeliveryGroup(positions, 500)),
        },
      })
      .mockResolvedValueOnce({ processed: positions[0], completedGroup: null });
    await expect(
      coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, input()),
    ).rejects.toThrow(/no longer covers replayed group members/);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("fails when a processed frontier has no completed group descriptor", async () => {
    mocks.load.mockResolvedValue({ processed: positions[1], completedGroup: null });
    await expect(
      coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, input()),
    ).rejects.toThrow(/no completed group descriptor/);
  });

  it("publishes only uncovered positions after a partial frontier cover", async () => {
    const completedGroup = {
      ...describeAnalyticsDeliveryGroup([positions[0]!], 500),
      ingestedAt: owner.ingestedAt,
      intentId: analyticsDeliveryGroupIntentId(describeAnalyticsDeliveryGroup([positions[0]!], 500)),
    };
    mocks.load
      .mockResolvedValueOnce({ processed: positions[0], completedGroup })
      .mockResolvedValueOnce({ processed: positions[0], completedGroup })
      .mockResolvedValue({ owner_id: "owner-1", processed: positions[0], pendingGroup: null });
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request);
    expect(request.publish).toHaveBeenCalledWith(
      owner,
      [positions[1]],
      expect.any(Array),
      new Set(),
    );
    expect(mocks.claim).toHaveBeenCalledWith(
      database,
      expect.objectContaining({ expectedOwnerId: "owner-1" }),
    );
  });

  it("skips fence selection when the delivery group has no user ids", async () => {
    const request = input();
    request.userIds = [];
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: owner.client }, request);
    expect(transaction.execute).not.toHaveBeenCalled();
    expect(request.publish).toHaveBeenCalledWith(owner, positions, expect.any(Array), new Set());
  });
});
