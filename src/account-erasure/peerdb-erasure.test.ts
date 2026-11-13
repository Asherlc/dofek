import { describe, expect, it, vi } from "vitest";
import type { AccountErasureIdentifierStore } from "./identifier-store.ts";
import {
  assertPeerDbAccountErasureDrained,
  captureAccountErasurePostgresWalLsn,
} from "./peerdb-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const drainedSlotRows = [
  {
    active: true,
    confirmed_flush_lsn: "0/200",
    reached_target: true,
    slot_name: "peerflow_slot_dofek_fitness_raw_analytics",
    wal_status: "reserved",
  },
  {
    active: true,
    confirmed_flush_lsn: "0/200",
    reached_target: true,
    slot_name: "peerflow_slot_dofek_provider_inventory_raw_analytics",
    wal_status: "reserved",
  },
  {
    active: true,
    confirmed_flush_lsn: "0/200",
    reached_target: true,
    slot_name: "peerflow_slot_dofek_sensor_priority_raw_analytics",
    wal_status: "reserved",
  },
];

function store(): Pick<
  AccountErasureIdentifierStore,
  "readPage" | "assertClosureComplete" | "loadPhysicalProgress"
> {
  return {
    assertClosureComplete: vi.fn(async () => undefined),
    loadPhysicalProgress: vi.fn(async () => ({ step: "physical" as const })),
    readPage: vi.fn(async () => ({ entries: [], nextCursor: null })),
  };
}
function client(remaining = 0, indirect = false) {
  const query = vi.fn(async ({ query }: { query: string }) => ({
    json: async () => {
      if (query.includes("SELECT count() AS tables")) return [{ tables: 1, bytes: 1024 }];
      if (query.includes("FROM system.tables AS tables"))
        return [
          {
            database: "postgres_fitness",
            name: indirect ? "activity_links" : "user_profile",
            uuid: userId,
            engine: "ReplacingMergeTree",
            age_milliseconds: 0,
            columns: [
              [indirect ? "activity_id" : "id", "UUID"],
              ["_peerdb_is_deleted", "Int8"],
            ],
          },
        ];
      return [{ count: remaining }];
    },
  }));
  return { query };
}
describe("PeerDB account-erasure proof", () => {
  it("captures the deletion WAL boundary", async () => {
    await expect(
      captureAccountErasurePostgresWalLsn({ execute: vi.fn(async () => [{ wal_lsn: "0/1A2B" }]) }),
    ).resolves.toBe("0/1A2B");
  });
  it("requires a returned WAL boundary", async () => {
    await expect(
      captureAccountErasurePostgresWalLsn({ execute: vi.fn(async () => []) }),
    ).rejects.toThrow("did not return");
  });
  it.each(["not-a-lsn", "0/", "0/xyz", "xyz/100"])(
    "rejects an invalid WAL boundary: %s",
    async (walLsn) => {
      await expect(
        captureAccountErasurePostgresWalLsn({ execute: vi.fn(async () => [{ wal_lsn: walLsn }]) }),
      ).rejects.toThrow();
    },
  );
  it.each([
    ["inactive", { active: false }],
    ["lost", { wal_status: "lost" }],
    ["missing flush LSN", { confirmed_flush_lsn: null }],
  ] as const)("requires healthy managed mirror slots: %s", async (_label, change) => {
    const database = {
      execute: vi.fn(async () =>
        drainedSlotRows.map((row, index) => (index === 0 ? { ...row, ...change } : row)),
      ),
    };
    await expect(
      assertPeerDbAccountErasureDrained(database, client(), "0/100", { userId, store: store() }),
    ).rejects.toThrow("not healthy");
  });
  it("requires every managed mirror slot", async () => {
    await expect(
      assertPeerDbAccountErasureDrained(
        { execute: vi.fn(async () => drainedSlotRows.slice(1)) },
        client(),
        "0/100",
        { userId, store: store() },
      ),
    ).rejects.toThrow("missing managed mirror slot");
  });
  it("requires the deletion boundary to be acknowledged", async () => {
    await expect(
      assertPeerDbAccountErasureDrained(
        {
          execute: vi.fn(async () =>
            drainedSlotRows.map((row, index) => ({ ...row, reached_target: index !== 0 })),
          ),
        },
        client(),
        "0/300",
        { userId, store: store() },
      ),
    ).rejects.toThrow("has not flushed");
  });
  it("fails visibly on a live mirrored account row", async () => {
    await expect(
      assertPeerDbAccountErasureDrained(
        { execute: vi.fn(async () => drainedSlotRows) },
        client(1),
        "0/100",
        { userId, store: store() },
      ),
    ).rejects.toThrow("still exposes active account rows");
  });
  it("propagates a later canonical page failure instead of completing a partial proof", async () => {
    const identifiers = store();
    vi.mocked(identifiers.readPage)
      .mockResolvedValueOnce({
        entries: [{ key: "a".repeat(64), value: userId }],
        nextCursor: "a".repeat(64),
      })
      .mockRejectedValueOnce(new Error("second page unavailable"));
    await expect(
      assertPeerDbAccountErasureDrained(
        { execute: vi.fn(async () => drainedSlotRows) },
        client(0, true),
        "0/100",
        { userId, store: identifiers },
      ),
    ).rejects.toThrow("second page unavailable");
    expect(identifiers.readPage).toHaveBeenNthCalledWith(2, "activity", "a".repeat(64));
  });
  it("accepts a complete initial-closure and WAL proof", async () => {
    const identifiers = store();
    await expect(
      assertPeerDbAccountErasureDrained(
        { execute: vi.fn(async () => drainedSlotRows) },
        client(),
        "0/100",
        { userId, store: identifiers },
      ),
    ).resolves.toBeUndefined();
    expect(identifiers.assertClosureComplete).toHaveBeenCalledTimes(2);
    expect(identifiers.assertClosureComplete).toHaveBeenCalledWith("initial");
    expect(identifiers.loadPhysicalProgress).toHaveBeenCalledWith("initial");
  });
  it("fails closed when initial physical preparation is missing", async () => {
    const identifiers = store();
    const database = { execute: vi.fn(async () => drainedSlotRows) };
    vi.mocked(identifiers.loadPhysicalProgress).mockResolvedValue(null);
    await expect(
      assertPeerDbAccountErasureDrained(database, client(), "0/100", {
        userId,
        store: identifiers,
      }),
    ).rejects.toThrow("Account erasure physical preparation is incomplete");
    expect(identifiers.assertClosureComplete).toHaveBeenCalledWith("initial");
    expect(identifiers.loadPhysicalProgress).toHaveBeenCalledWith("initial");
    expect(database.execute).not.toHaveBeenCalled();
  });
});
