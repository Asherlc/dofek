import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/index.ts";
import { coordinateAnalyticsDeliveryGroup } from "./analytics-delivery.ts";
import {
  analyticsDeliveryGroupIntentId,
  describeAnalyticsDeliveryGroup,
} from "./analytics-delivery-group.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { analyticsEffect, analyticsPosition } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  claim: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  writeOwner: vi.fn(),
  receiptOwner: vi.fn(),
  prepareGroup: vi.fn(),
  commit: vi.fn(),
  verify: vi.fn(),
  readMembers: vi.fn(),
  hasReceipt: vi.fn(),
}));
vi.mock("./analytics-work-store.ts", () => ({
  loadAnalyticsStreamState: mocks.load,
  claimAnalyticsStream: mocks.claim,
  beginAnalyticsDeliveryGroup: mocks.begin,
  completeAnalyticsDeliveryGroup: mocks.complete,
}));
vi.mock("./analytics-query-owner.ts", () => ({
  ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
  withAnalyticsQueryOwner: mocks.writeOwner,
  withAnalyticsReceiptQueryOwner: mocks.receiptOwner,
}));
vi.mock("./effect-journal-group.ts", () => ({
  prepareAnalyticsDeliveryGroup: mocks.prepareGroup,
  commitAnalyticsDeliveryGroup: mocks.commit,
  verifyAnalyticsDeliveryReceipts: mocks.verify,
  readAnalyticsDeliveryGroupPositions: mocks.readMembers,
}));
vi.mock("./effect-journal.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./effect-journal.ts")>()),
  hasCompleteAnalyticsDeliveryReceipt: mocks.hasReceipt,
  commitPreparedAnalyticsDelivery: vi.fn(),
  prepareAnalyticsDelivery: vi.fn(),
  readPreparedAnalyticsEffectPages: vi.fn(),
}));

const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());
const stream = { transport: "pulsar" as const, epoch: "epoch", topic: "sensor", partition: -1 };
const positions = [1n, 2n, 3n].map((entry) => analyticsPosition(stream, entry));
const effects = positions.map((position) => analyticsEffect(position, 0n, randomUUID()));
const client = {
  exec: async () => {
    throw new Error("Unexpected raw exec outside source application");
  },
  command: async () => undefined,
  insert: async () => undefined,
  query: async () => ({ json: async () => [] }),
};
const trace: string[] = [];
const owner: AnalyticsQueryOwner = {
  client,
  ingestedAt: "2026-11-04T00:00:00.000001Z",
  assertActive: async () => undefined,
  reserveIngestionThrough: async () => {
    trace.push("reserve");
  },
  reuseIngestionReservation: async () => {
    trace.push("reuse");
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  trace.length = 0;
  owner.client = client;
  mocks.load.mockResolvedValue(null);
  mocks.writeOwner.mockImplementation(async (_database, _client, _input, operation) =>
    operation(owner),
  );
  mocks.receiptOwner.mockImplementation(async (_database, _client, _input, verify) =>
    verify(owner),
  );
  mocks.claim.mockImplementation(async () => {
    trace.push("claim");
  });
  mocks.begin.mockImplementation(async () => {
    trace.push("begin");
  });
  mocks.prepareGroup.mockImplementation(async (_client, input) => ({
    positions: input.positions,
    effects: await input.prepare(),
    fresh: true,
  }));
  mocks.commit.mockImplementation(async () => {
    trace.push("receipts");
  });
  mocks.complete.mockImplementation(async () => {
    trace.push("frontier");
  });
});
function input() {
  return {
    positions,
    maximum: 500,
    assertActive: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn(async () => {
      trace.push("prepare");
      return effects;
    }),
    apply: vi.fn(async () => {
      trace.push("raw");
    }),
  };
}

describe("grouped analytics coordination", () => {
  it("retains prepared work without committed receipts or frontier on raw write validation failure", async () => {
    const actual = await vi.importActual<typeof import("./effect-journal-group.ts")>(
      "./effect-journal-group.ts",
    );
    mocks.prepareGroup.mockImplementation(actual.prepareAnalyticsDeliveryGroup);
    mocks.commit.mockImplementation(actual.commitAnalyticsDeliveryGroup);
    const artifacts: { table: string; statuses: unknown[] }[] = [];
    owner.client = {
      ...client,
      query: async ({ query }) => ({
        json: async () =>
          JSON.parse(query.includes("SELECT count()>0 AS present") ? '[{"present":0}]' : "[]"),
      }),
      insert: async ({ table, values }) => {
        artifacts.push({
          table,
          statuses: values.map((row) => ("status" in row ? row.status : null)),
        });
      },
    };
    const request = input();
    request.apply.mockRejectedValue(new Error("Raw write summary written_rows mismatch"));
    await expect(
      coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, request),
    ).rejects.toThrow(/written_rows mismatch/);
    expect(artifacts).toEqual([
      { table: "analytics.effect_journal", statuses: [null, null, null] },
      { table: "analytics.delivery_receipt", statuses: ["prepared", "prepared", "prepared"] },
    ]);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("writes prepared intents before raw work and committed receipts before the frontier", async () => {
    const actual = await vi.importActual<typeof import("./effect-journal-group.ts")>(
      "./effect-journal-group.ts",
    );
    mocks.prepareGroup.mockImplementation(actual.prepareAnalyticsDeliveryGroup);
    mocks.commit.mockImplementation(actual.commitAnalyticsDeliveryGroup);
    owner.client = {
      exec: client.exec,
      command: client.command,
      query: async ({ query }) => ({
        json: async () =>
          JSON.parse(query.includes("SELECT count()>0 AS present") ? '[{"present":0}]' : "[]"),
      }),
      insert: async ({ table, values }) => {
        if (table === "analytics.effect_journal") trace.push("journal");
        if (table === "analytics.effect_receipt") trace.push("effect-receipts");
        if (table === "analytics.delivery_receipt") {
          expect(values).toHaveLength(3);
          trace.push(
            values.every((row) => "status" in row && row.status === "prepared")
              ? "prepared"
              : "committed",
          );
        }
      },
    };
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, request);
    expect(trace).toEqual([
      "claim",
      "begin",
      "reserve",
      "prepare",
      "journal",
      "prepared",
      "raw",
      "effect-receipts",
      "committed",
      "frontier",
    ]);
  });

  it("admits exact membership and reserves time before raw work, receipts and frontier", async () => {
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, request);
    expect(trace).toEqual(["claim", "begin", "reserve", "prepare", "raw", "receipts", "frontier"]);
    expect(request.apply).toHaveBeenCalledWith(owner, positions, effects, [
      "2026-11-04T00:00:00.000001Z",
      "2026-11-04T00:00:00.000002Z",
      "2026-11-04T00:00:00.000003Z",
    ]);
    expect(mocks.complete).toHaveBeenCalledWith(
      database,
      client,
      expect.objectContaining({ positions, maximum: 500 }),
    );
  });

  it.each(["prepare", "apply"] as const)(
    "does not commit receipts or advance the frontier after %s failure",
    async (phase) => {
      const request = input();
      request[phase].mockRejectedValue(new Error("storage failure"));
      await expect(
        coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, request),
      ).rejects.toThrow("storage failure");
      expect(mocks.commit).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );

  it("replays pending members at their original times and skips already committed raw work", async () => {
    const group = describeAnalyticsDeliveryGroup(positions, 500);
    mocks.load.mockResolvedValue({
      owner_id: randomUUID(),
      processed: null,
      pendingGroup: {
        ...group,
        ingestedAt: "2026-11-03T23:59:59.999999Z",
        intentId: analyticsDeliveryGroupIntentId(group),
      },
    });
    mocks.prepareGroup.mockResolvedValue({ positions, effects, fresh: false });
    mocks.hasReceipt.mockResolvedValueOnce(true).mockResolvedValue(false);
    const request = input();
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, request);
    expect(mocks.prepareGroup).toHaveBeenCalledWith(
      owner.client,
      expect.objectContaining({ wasPending: true }),
    );
    expect(trace).toContain("reuse");
    expect(trace).not.toContain("reserve");
    expect(request.prepare).not.toHaveBeenCalled();
    expect(request.apply).toHaveBeenCalledWith(owner, positions.slice(1), effects.slice(1), [
      "2026-11-04T00:00:00.000000Z",
      "2026-11-04T00:00:00.000001Z",
    ]);
    expect(mocks.complete).toHaveBeenCalled();
  });

  it("verifies every original completed member before returning the exact recovery intent", async () => {
    const group = describeAnalyticsDeliveryGroup(positions, 500);
    mocks.load.mockResolvedValue({
      processed: positions[2],
      completedGroup: { ...group, intentId: "original-completed-intent" },
    });
    mocks.readMembers.mockResolvedValue(positions);
    const request = { ...input(), positions: positions.slice(2) };
    await coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, request);
    expect(mocks.verify.mock.calls.map((call) => call[1])).toEqual([positions.slice(2), positions]);
    expect(await mocks.receiptOwner.mock.results[0]?.value).toEqual({
      completedIntentId: "original-completed-intent",
    });
    expect(mocks.writeOwner).not.toHaveBeenCalled();
    expect(request.apply).not.toHaveBeenCalled();
    expect(request.assertActive).toHaveBeenCalled();
  });

  it("stops covered replay on missing receipt proof without admitting another write", async () => {
    mocks.load.mockResolvedValue({ processed: positions[2], completedGroup: null });
    mocks.verify.mockRejectedValue(new Error("receipt proof missing"));
    await expect(
      coordinateAnalyticsDeliveryGroup({ database, clickhouse: client }, input()),
    ).rejects.toThrow("receipt proof missing");
    expect(mocks.writeOwner).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
