import { describe, expect, it } from "vitest";
import {
  assertClickHouseCdcHealth,
  type CdcHealthClickHouseClient,
  checkClickHouseCdcHealth,
  type PostgresQueryClient,
} from "./clickhouse-cdc-health.ts";

interface SlotRow {
  active: boolean;
  restart_lsn: string | null;
  retained_wal_bytes: number | string | null;
  slot_name: string;
  wal_status: string | null;
}

interface FreshnessRow {
  latest_peerdb_synced_at: string | null;
  row_count: number | string;
  table_name: string;
}

interface PeerDbMirrorRow {
  name: string;
  status: number | string | null;
  updated_at: string | null;
  workflow_id: string | null;
}

class FakePostgresClient implements PostgresQueryClient {
  readonly #rows: readonly SlotRow[];
  queryTexts: string[] = [];

  constructor(rows: readonly SlotRow[]) {
    this.#rows = rows;
  }

  async query(queryText: string): Promise<unknown> {
    this.queryTexts.push(queryText);
    return { rows: this.#rows };
  }
}

class FakeClickHouseClient implements CdcHealthClickHouseClient {
  readonly #rows: readonly FreshnessRow[];
  queryOptions: Array<{ query: string; format: "JSONEachRow" }> = [];

  constructor(rows: readonly FreshnessRow[]) {
    this.#rows = rows;
  }

  async query(options: {
    query: string;
    format: "JSONEachRow";
  }): Promise<{ json(): Promise<unknown> }> {
    this.queryOptions.push(options);
    return {
      json: async () => this.#rows,
    };
  }
}

class FakePeerDbClient implements PostgresQueryClient {
  readonly #rows: readonly PeerDbMirrorRow[];
  queryTexts: string[] = [];

  constructor(rows: readonly PeerDbMirrorRow[]) {
    this.#rows = rows;
  }

  async query(queryText: string): Promise<unknown> {
    this.queryTexts.push(queryText);
    return { rows: this.#rows };
  }
}

const slotNames = [
  "peerflow_slot_dofek_fitness_raw_analytics",
  "peerflow_slot_dofek_provider_inventory_raw_analytics",
  "peerflow_slot_dofek_sensor_priority_raw_analytics",
] as const;

const mirrorNames = [
  "dofek_fitness_raw_analytics",
  "dofek_provider_inventory_raw_analytics",
  "dofek_sensor_priority_raw_analytics",
] as const;

function healthySlotRows(overrides: Partial<SlotRow> = {}): SlotRow[] {
  return slotNames.map((slotName) => ({
    active: true,
    restart_lsn: "33/A67E2A78",
    retained_wal_bytes: "1024",
    slot_name: slotName,
    wal_status: "reserved",
    ...overrides,
  }));
}

function healthyPeerDbMirrorRows(overrides: Partial<PeerDbMirrorRow> = {}): PeerDbMirrorRow[] {
  return mirrorNames.map((mirrorName) => ({
    name: mirrorName,
    status: 1,
    updated_at: "2026-06-03 19:45:00.000000",
    workflow_id: `${mirrorName}-peerflow`,
    ...overrides,
  }));
}

function healthyFreshnessRows(
  latestPeerDbSyncedAt = "2026-06-03 19:30:00.000000000",
): FreshnessRow[] {
  return [
    {
      latest_peerdb_synced_at: latestPeerDbSyncedAt,
      row_count: "10",
      table_name: "sleep_session",
    },
    {
      latest_peerdb_synced_at: latestPeerDbSyncedAt,
      row_count: "10",
      table_name: "activity",
    },
  ];
}

function withSlotOverride(
  slotRows: readonly SlotRow[],
  slotName: (typeof slotNames)[number],
  overrides: Partial<SlotRow>,
): SlotRow[] {
  return slotRows.map((slotRow) =>
    slotRow.slot_name === slotName ? { ...slotRow, ...overrides } : slotRow,
  );
}

async function checkHealth(slotRows: readonly SlotRow[], freshnessRows: readonly FreshnessRow[]) {
  return checkClickHouseCdcHealth({
    postgresClient: new FakePostgresClient(slotRows),
    clickHouseClient: new FakeClickHouseClient(freshnessRows),
    now: new Date("2026-06-03T20:00:00.000Z"),
  });
}

describe("checkClickHouseCdcHealth", () => {
  it("passes when every slot is active and mirrored tables are fresh", async () => {
    const postgresClient = new FakePostgresClient(healthySlotRows());
    const clickHouseClient = new FakeClickHouseClient(healthyFreshnessRows());

    const report = await checkClickHouseCdcHealth({
      postgresClient,
      clickHouseClient,
      now: new Date("2026-06-03T20:00:00.000Z"),
    });

    expect(report.issues).toEqual([]);
    expect(report.slotCount).toBe(3);
    expect(report.mirrorCount).toBe(2);
    expect(clickHouseClient.queryOptions).toEqual([
      {
        format: "JSONEachRow",
        query:
          "SELECT 'sleep_session' AS table_name, count() AS row_count, " +
          "max(_peerdb_synced_at) AS latest_peerdb_synced_at FROM " +
          "postgres_fitness.sleep_session WHERE _peerdb_is_deleted = 0",
      },
    ]);
    expect(() => assertClickHouseCdcHealth(report)).not.toThrow();
  });

  it("uses the current time when no explicit clock is supplied", async () => {
    const report = await checkClickHouseCdcHealth({
      postgresClient: new FakePostgresClient(healthySlotRows()),
      clickHouseClient: new FakeClickHouseClient(healthyFreshnessRows("1970-01-01 00:00:00")),
    });

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "ClickHouse mirror postgres_fitness.sleep_session last synced at " +
        "1970-01-01 00:00:00, older than 2160 minutes",
    });
  });

  it("fails when a required PeerDB replication slot is missing", async () => {
    const report = await checkHealth(healthySlotRows().slice(1), healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "failure",
      message: "Missing required PeerDB replication slot peerflow_slot_dofek_fitness_raw_analytics",
    });
  });

  it("fails when a required PeerDB raw mirror is missing from the catalog", async () => {
    const report = await checkClickHouseCdcHealth({
      postgresClient: new FakePostgresClient(healthySlotRows()),
      peerDbClient: new FakePeerDbClient(healthyPeerDbMirrorRows().slice(1)),
      clickHouseClient: new FakeClickHouseClient(healthyFreshnessRows()),
      now: new Date("2026-06-03T20:00:00.000Z"),
    });

    expect(report.peerDbMirrorCount).toBe(2);
    expect(report.issues).toContainEqual({
      severity: "failure",
      message: "Missing required PeerDB raw mirror dofek_fitness_raw_analytics",
    });
  });

  it("records sanitized PeerDB and Postgres evidence for failed health checks", async () => {
    const report = await checkClickHouseCdcHealth({
      postgresClient: new FakePostgresClient(healthySlotRows().slice(1)),
      peerDbClient: new FakePeerDbClient(healthyPeerDbMirrorRows().slice(1)),
      clickHouseClient: new FakeClickHouseClient(healthyFreshnessRows()),
      now: new Date("2026-06-03T20:00:00.000Z"),
    });

    expect(report.evidence).toEqual({
      peerDbMirrors: [
        {
          name: "dofek_provider_inventory_raw_analytics",
          status: "1",
          updatedAt: "2026-06-03 19:45:00.000000",
          workflowId: "dofek_provider_inventory_raw_analytics-peerflow",
        },
        {
          name: "dofek_sensor_priority_raw_analytics",
          status: "1",
          updatedAt: "2026-06-03 19:45:00.000000",
          workflowId: "dofek_sensor_priority_raw_analytics-peerflow",
        },
      ],
      replicationSlots: [
        {
          active: true,
          retainedWalBytes: "1024",
          slotName: "peerflow_slot_dofek_provider_inventory_raw_analytics",
          walStatus: "reserved",
        },
        {
          active: true,
          retainedWalBytes: "1024",
          slotName: "peerflow_slot_dofek_sensor_priority_raw_analytics",
          walStatus: "reserved",
        },
      ],
    });
    expect(() => assertClickHouseCdcHealth(report)).toThrow(
      "CDC health evidence:\n" +
        "- PeerDB raw mirrors observed: dofek_provider_inventory_raw_analytics(status=1, workflow=dofek_provider_inventory_raw_analytics-peerflow), dofek_sensor_priority_raw_analytics(status=1, workflow=dofek_sensor_priority_raw_analytics-peerflow)\n" +
        "- Postgres replication slots observed: peerflow_slot_dofek_provider_inventory_raw_analytics(active=true, wal_status=reserved, retained_wal_bytes=1024), peerflow_slot_dofek_sensor_priority_raw_analytics(active=true, wal_status=reserved, retained_wal_bytes=1024)",
    );
  });

  it("fails when a required PeerDB replication slot is lost", async () => {
    const slotRows = withSlotOverride(
      healthySlotRows(),
      "peerflow_slot_dofek_fitness_raw_analytics",
      {
        restart_lsn: null,
        wal_status: "lost",
      },
    );

    const report = await checkHealth(slotRows, healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "failure",
      message: "PeerDB replication slot peerflow_slot_dofek_fitness_raw_analytics is lost",
    });
    expect(() => assertClickHouseCdcHealth(report)).toThrow("ClickHouse CDC health check failed");
  });

  it("fails when a required PeerDB replication slot is inactive", async () => {
    const slotRows = withSlotOverride(
      healthySlotRows(),
      "peerflow_slot_dofek_provider_inventory_raw_analytics",
      { active: false },
    );

    const report = await checkHealth(slotRows, healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "PeerDB replication slot peerflow_slot_dofek_provider_inventory_raw_analytics is inactive",
    });
  });

  it("warns when retained WAL bytes are unknown", async () => {
    const slotRows = withSlotOverride(
      healthySlotRows(),
      "peerflow_slot_dofek_sensor_priority_raw_analytics",
      { retained_wal_bytes: null },
    );

    const report = await checkHealth(slotRows, healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "warning",
      message:
        "PeerDB replication slot peerflow_slot_dofek_sensor_priority_raw_analytics has unknown " +
        "retained WAL bytes",
    });
  });

  it("warns before retained WAL reaches the failure threshold", async () => {
    const slotRows = withSlotOverride(
      healthySlotRows(),
      "peerflow_slot_dofek_fitness_raw_analytics",
      {
        retained_wal_bytes: String(16 * 1024 * 1024 * 1024),
      },
    );

    const report = await checkHealth(slotRows, healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "warning",
      message:
        "PeerDB replication slot peerflow_slot_dofek_fitness_raw_analytics retains " +
        "17179869184 WAL bytes, above warning threshold 17179869184",
    });
    expect(() => assertClickHouseCdcHealth(report)).not.toThrow();
  });

  it("fails before retained WAL reaches the Postgres lost-slot cap", async () => {
    const slotRows = withSlotOverride(
      healthySlotRows(),
      "peerflow_slot_dofek_fitness_raw_analytics",
      {
        retained_wal_bytes: String(32 * 1024 * 1024 * 1024),
      },
    );

    const report = await checkHealth(slotRows, healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "PeerDB replication slot peerflow_slot_dofek_fitness_raw_analytics retains " +
        "34359738368 WAL bytes, above failure threshold 34359738368",
    });
  });

  it("accepts numeric retained WAL bytes and row counts", async () => {
    const report = await checkClickHouseCdcHealth({
      postgresClient: new FakePostgresClient(
        healthySlotRows({
          retained_wal_bytes: 1024,
        }),
      ),
      clickHouseClient: new FakeClickHouseClient([
        {
          latest_peerdb_synced_at: "2026-06-03 19:30:00",
          row_count: 10,
          table_name: "sleep_session",
        },
      ]),
      now: new Date("2026-06-03T20:00:00.000Z"),
    });

    expect(report.issues).toEqual([]);
  });

  it("fails when an active ClickHouse mirror has not synced recently", async () => {
    const report = await checkHealth(
      healthySlotRows(),
      healthyFreshnessRows("2026-06-01 16:00:00.000000000"),
    );

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "ClickHouse mirror postgres_fitness.sleep_session last synced at " +
        "2026-06-01 16:00:00.000000000, older than 2160 minutes",
    });
  });

  it("does not fail when a mirror is exactly at its freshness boundary", async () => {
    const report = await checkHealth(
      healthySlotRows(),
      healthyFreshnessRows("2026-06-03 18:00:00.000000000"),
    );

    expect(report.issues).toEqual([]);
  });

  it("fails when ClickHouse returns an unparseable sync timestamp", async () => {
    const report = await checkHealth(healthySlotRows(), [
      {
        latest_peerdb_synced_at: "not-a-date",
        row_count: "10",
        table_name: "sleep_session",
      },
    ]);

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "ClickHouse mirror postgres_fitness.sleep_session returned an unparseable " +
        "_peerdb_synced_at value: not-a-date",
    });
  });

  it("warns instead of failing for empty staging mirrors", async () => {
    const report = await checkHealth(healthySlotRows(), [
      {
        latest_peerdb_synced_at: null,
        row_count: "0",
        table_name: "sleep_session",
      },
    ]);

    expect(report.issues).toEqual([
      {
        severity: "warning",
        message: "ClickHouse mirror postgres_fitness.sleep_session has no synced rows",
      },
    ]);
    expect(() => assertClickHouseCdcHealth(report)).not.toThrow();
  });

  it("rejects unsafe ClickHouse table names before querying ClickHouse", async () => {
    const clickHouseClient = new FakeClickHouseClient([]);

    await expect(
      checkClickHouseCdcHealth({
        postgresClient: new FakePostgresClient(healthySlotRows()),
        clickHouseClient,
        mirrorFreshnessChecks: [{ tableName: "metric-stream", maxAgeMilliseconds: 1 }],
      }),
    ).rejects.toThrow("Unsafe ClickHouse table name: metric-stream");
    expect(clickHouseClient.queryOptions).toEqual([]);
  });

  it("includes every failure message in the assertion error", async () => {
    const report = await checkHealth(
      withSlotOverride(healthySlotRows(), "peerflow_slot_dofek_fitness_raw_analytics", {
        active: false,
      }),
      [
        {
          latest_peerdb_synced_at: "not-a-date",
          row_count: "10",
          table_name: "sleep_session",
        },
      ],
    );

    expect(() => assertClickHouseCdcHealth(report)).toThrow(
      "ClickHouse CDC health check failed:\n" +
        "- PeerDB replication slot peerflow_slot_dofek_fitness_raw_analytics is inactive\n" +
        "- ClickHouse mirror postgres_fitness.sleep_session returned an unparseable " +
        "_peerdb_synced_at value: not-a-date",
    );
  });
});
