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
  retained_wal_bytes: string | null;
  slot_name: string;
  wal_status: string | null;
}

interface FreshnessRow {
  latest_peerdb_synced_at: string | null;
  row_count: string;
  table_name: string;
}

class FakePostgresClient implements PostgresQueryClient {
  readonly #rows: readonly SlotRow[];

  constructor(rows: readonly SlotRow[]) {
    this.#rows = rows;
  }

  async query(): Promise<unknown> {
    return { rows: this.#rows };
  }
}

class FakeClickHouseClient implements CdcHealthClickHouseClient {
  readonly #rows: readonly FreshnessRow[];

  constructor(rows: readonly FreshnessRow[]) {
    this.#rows = rows;
  }

  async query(): Promise<{ json(): Promise<unknown> }> {
    return {
      json: async () => this.#rows,
    };
  }
}

const slotNames = [
  "peerflow_slot_dofek_fitness_raw_analytics",
  "peerflow_slot_dofek_metric_stream_analytics",
  "peerflow_slot_dofek_provider_inventory_raw_analytics",
  "peerflow_slot_dofek_sensor_priority_raw_analytics",
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

function healthyFreshnessRows(
  latestPeerDbSyncedAt = "2026-06-03 19:30:00.000000000",
): FreshnessRow[] {
  return [
    {
      latest_peerdb_synced_at: latestPeerDbSyncedAt,
      row_count: "10",
      table_name: "metric_stream",
    },
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
    const report = await checkHealth(healthySlotRows(), healthyFreshnessRows());

    expect(report.issues).toEqual([]);
    expect(() => assertClickHouseCdcHealth(report)).not.toThrow();
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

  it("fails before retained WAL reaches the Postgres lost-slot cap", async () => {
    const slotRows = withSlotOverride(
      healthySlotRows(),
      "peerflow_slot_dofek_metric_stream_analytics",
      {
        retained_wal_bytes: String(12 * 1024 * 1024 * 1024),
      },
    );

    const report = await checkHealth(slotRows, healthyFreshnessRows());

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "PeerDB replication slot peerflow_slot_dofek_metric_stream_analytics retains " +
        "12884901888 WAL bytes, above failure threshold 12884901888",
    });
  });

  it("fails when an active ClickHouse mirror has not synced recently", async () => {
    const report = await checkHealth(
      healthySlotRows(),
      healthyFreshnessRows("2026-06-03 16:00:00.000000000"),
    );

    expect(report.issues).toContainEqual({
      severity: "failure",
      message:
        "ClickHouse mirror postgres_fitness.metric_stream last synced at " +
        "2026-06-03 16:00:00.000000000, older than 120 minutes",
    });
  });

  it("warns instead of failing for empty staging mirrors", async () => {
    const report = await checkHealth(healthySlotRows(), [
      {
        latest_peerdb_synced_at: null,
        row_count: "0",
        table_name: "metric_stream",
      },
    ]);

    expect(report.issues).toEqual([
      {
        severity: "warning",
        message: "ClickHouse mirror postgres_fitness.metric_stream has no synced rows",
      },
    ]);
    expect(() => assertClickHouseCdcHealth(report)).not.toThrow();
  });
});
