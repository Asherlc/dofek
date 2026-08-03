import { describe, expect, it, vi } from "vitest";
import {
  assertPeerDbAccountErasureDrained,
  captureAccountErasurePostgresWalLsn,
} from "./peerdb-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const activityId = "20000000-0000-4000-8000-000000001994";
const sleepSessionId = "30000000-0000-4000-8000-000000001994";
const operationId = "40000000-0000-4000-8000-000000001994";

interface PeerDbTable {
  database: string;
  engine: string;
  has_activity_id?: boolean;
  has_id?: boolean;
  has_operation_id?: boolean;
  has_session_id?: boolean;
  has_sleep_session_id?: boolean;
  has_user_id?: boolean;
  name: string;
}

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

function clickHouseClient(
  remainingRows = 0,
  tables: PeerDbTable[] = [
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
      has_activity_id: true,
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
    {
      database: "postgres_fitness",
      engine: "ReplacingMergeTree",
      has_sleep_session_id: true,
      name: "sleep_summary",
    },
  ],
) {
  const query = vi.fn(async (options: { query: string }) => {
    if (options.query.includes("FROM system.tables")) {
      return { json: async () => tables };
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

  it("fails when Postgres omits the WAL boundary row", async () => {
    const database = { execute: vi.fn(async () => []) };

    await expect(captureAccountErasurePostgresWalLsn(database)).rejects.toThrow(
      "did not return an account-erasure WAL boundary",
    );
  });

  it.each([
    "not-a-lsn",
    "0/",
    "0/xyz",
    "xyz/100",
  ])("rejects an invalid Postgres WAL boundary: %s", async (walLsn) => {
    const database = {
      execute: vi.fn(async () => [{ wal_lsn: walLsn }]),
    };

    await expect(captureAccountErasurePostgresWalLsn(database)).rejects.toThrow();
  });

  it.each([
    ["inactive", { active: false }],
    ["lost", { wal_status: "lost" }],
    ["without a confirmed flush LSN", { confirmed_flush_lsn: null }],
  ])("rejects a managed mirror slot that is %s", async (_label, change) => {
    const database = {
      execute: vi.fn(async () =>
        drainedSlotRows.map((row, index) => (index === 0 ? { ...row, ...change } : row)),
      ),
    };

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouseClient(), "0/100", {
        activityIds: [],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      }),
    ).rejects.toThrow("is not healthy for account-erasure proof");
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

  it("checks every supported PeerDB ownership predicate and skips unrelated tables", async () => {
    const database = { execute: vi.fn(async () => drainedSlotRows) };
    const clickHouse = clickHouseClient(0, [
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_id: false,
        has_user_id: false,
        name: "unrelated_rows",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_activity_id: true,
        name: "activity_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_operation_id: true,
        name: "operation_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_session_id: true,
        name: "session_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_sleep_session_id: true,
        name: "sleep_session_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_id: true,
        name: "user_profile",
      },
    ]);

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
        query: expect.stringContaining("activity_id IN {activity_ids:Array(UUID)}"),
        query_params: { activity_ids: [activityId] },
      }),
    );
    expect(clickHouse.query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("sleep_session_id IN {sleep_session_ids:Array(UUID)}"),
        query_params: { sleep_session_ids: [sleepSessionId] },
      }),
    );
    expect(
      clickHouse.query.mock.calls.filter(([options]) =>
        options.query.includes("FROM `postgres_fitness`"),
      ),
    ).toHaveLength(5);
  });

  it("does not infer user ownership from an id column on another table", async () => {
    const database = { execute: vi.fn(async () => drainedSlotRows) };
    const clickHouse = clickHouseClient(0, [
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_id: true,
        name: "id_only_table",
      },
    ]);

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

  it("does not query supported tables when no matching identifiers were captured", async () => {
    const database = { execute: vi.fn(async () => drainedSlotRows) };
    const clickHouse = clickHouseClient(0, [
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_activity_id: true,
        name: "activity_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_operation_id: true,
        name: "operation_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_session_id: true,
        name: "session_links",
      },
      {
        database: "postgres_fitness",
        engine: "ReplacingMergeTree",
        has_sleep_session_id: true,
        name: "sleep_links",
      },
    ]);

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

  it("fails when a managed mirror slot is missing from the verification result", async () => {
    const database = {
      execute: vi.fn(async () => drainedSlotRows.slice(1)),
    };

    await expect(
      assertPeerDbAccountErasureDrained(database, clickHouseClient(), "0/100", {
        activityIds: [],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      }),
    ).rejects.toThrow("missing managed mirror slot");
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
