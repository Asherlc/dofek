import { describe, expect, it, vi } from "vitest";
import {
  assertPeerDbAccountErasureDrained,
  captureAccountErasurePostgresWalLsn,
} from "./peerdb-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const activityId = "20000000-0000-4000-8000-000000001994";
const sleepSessionId = "30000000-0000-4000-8000-000000001994";
const operationId = "40000000-0000-4000-8000-000000001994";

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

function clickHouseClient(remainingRows = 0) {
  const query = vi.fn(async (options: { query: string }) => {
    if (options.query.includes("FROM system.tables")) {
      return {
        json: async () => [
          {
            database: "postgres_fitness",
            engine: "ReplacingMergeTree",
            has_id: true,
            has_user_id: false,
            name: "user_profile",
          },
          {
            database: "postgres_fitness",
            engine: "ReplacingMergeTree",
            has_id: true,
            has_user_id: true,
            name: "activity",
          },
          {
            database: "postgres_fitness",
            engine: "ReplacingMergeTree",
            has_operation_id: true,
            name: "processing_flow_marker",
          },
          {
            database: "postgres_fitness",
            engine: "ReplacingMergeTree",
            has_session_id: true,
            name: "sleep_stage",
          },
        ],
      };
    }
    return { json: async () => [{ count: String(remainingRows) }] };
  });
  return { query };
}

describe("PeerDB account-erasure proof", () => {
  it("captures a Postgres WAL boundary after relational erasure", async () => {
    const database = {
      execute: vi.fn(async () => [{ wal_lsn: "0/1A2B" }]),
    };

    await expect(captureAccountErasurePostgresWalLsn(database)).resolves.toBe("0/1A2B");
  });

  it("requires every managed mirror slot to flush through the deletion WAL boundary and verifies no active mirrored rows", async () => {
    const database = {
      execute: vi.fn(async () => drainedSlotRows),
    };
    const clickHouse = clickHouseClient();

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouse, "0/100", {
        activityIds: [activityId],
        operationIds: [operationId],
        sleepSessionIds: [sleepSessionId],
        userId,
      }),
    ).resolves.toBeUndefined();

    expect(clickHouse.query).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: { log_queries: 0 },
        query: expect.stringContaining("_peerdb_is_deleted = 0"),
        query_params: { user_id: userId },
      }),
    );
    const discoveryCall = clickHouse.query.mock.calls.find(([options]) =>
      options.query.includes("FROM system.tables"),
    );
    expect(discoveryCall?.[0].query).not.toContain("engine LIKE");
    expect(clickHouse.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("operation_id IN {operation_ids:Array(UUID)}"),
        query_params: { operation_ids: [operationId] },
      }),
    );
    expect(clickHouse.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("session_id IN {sleep_session_ids:Array(UUID)}"),
        query_params: { sleep_session_ids: [sleepSessionId] },
      }),
    );
  });

  it("fails closed when a managed PeerDB mirror has not acknowledged the deletion boundary", async () => {
    const database = {
      execute: vi.fn(async () =>
        drainedSlotRows.map((row, index) =>
          index === 0 ? { ...row, reached_target: false } : row,
        ),
      ),
    };

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouseClient(), "0/300", {
        activityIds: [],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      }),
    ).rejects.toThrow("has not flushed the account-erasure WAL boundary");
  });

  it("fails when PeerDB still exposes an active mirrored account row", async () => {
    const database = {
      execute: vi.fn(async () => drainedSlotRows),
    };

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouseClient(1), "0/100", {
        activityIds: [activityId],
        operationIds: [operationId],
        sleepSessionIds: [sleepSessionId],
        userId,
      }),
    ).rejects.toThrow("still exposes active account rows");
  });

  it("fails closed on an unsupported physical storage engine in the managed mirror", async () => {
    const database = {
      execute: vi.fn(async () => drainedSlotRows),
    };
    const clickHouse = {
      query: vi.fn(async (options: { query: string }) => {
        if (options.query.includes("FROM system.tables")) {
          return {
            json: async () => [
              {
                database: "postgres_fitness",
                engine: "Memory",
                has_user_id: true,
                name: "ephemeral_account_rows",
              },
            ],
          };
        }
        return { json: async () => [{ count: "0" }] };
      }),
    };

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouse, "0/100", {
        activityIds: [],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      }),
    ).rejects.toThrow(
      "Unsupported ClickHouse physical storage engine for postgres_fitness.ephemeral_account_rows: Memory",
    );
  });

  it("explicitly skips known non-storage engines in the managed mirror", async () => {
    const database = {
      execute: vi.fn(async () => drainedSlotRows),
    };
    const clickHouse = {
      query: vi.fn(async (options: { query: string }) => {
        if (options.query.includes("FROM system.tables")) {
          return {
            json: async () => [
              {
                database: "postgres_fitness",
                engine: "View",
                has_user_id: true,
                name: "account_rows_view",
              },
            ],
          };
        }
        return { json: async () => [{ count: "1" }] };
      }),
    };

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouse, "0/100", {
        activityIds: [],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      }),
    ).resolves.toBeUndefined();
    expect(clickHouse.query).toHaveBeenCalledTimes(1);
  });
});
