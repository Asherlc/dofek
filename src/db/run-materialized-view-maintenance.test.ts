import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./materialized-view-maintenance.ts", () => ({
  MATERIALIZED_VIEW_REFRESH_INVENTORY: [
    {
      concurrentRefreshIndex: "v_daily_metrics_date_idx",
      notes: "Daily metric priority view.",
      refreshRisk: "medium",
      viewName: "fitness.v_daily_metrics",
    },
  ],
  refreshMaterializedViewForMaintenance: vi.fn(),
  runQuietDatabasePreflight: vi.fn(),
}));

vi.mock("./sync-views.ts", () => ({
  syncMaterializedViews: vi.fn(),
}));

const { mockClientConnect, mockClientEnd, mockClientConstructor } = vi.hoisted(() => {
  const clientInstance = {
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return {
    mockClientConnect: clientInstance.connect,
    mockClientConstructor: vi.fn(() => clientInstance),
    mockClientEnd: clientInstance.end,
  };
});

vi.mock("pg", async (importOriginal) => {
  const original = await importOriginal<typeof import("pg")>();
  return {
    ...original,
    Client: mockClientConstructor,
  };
});

import {
  refreshMaterializedViewForMaintenance,
  runQuietDatabasePreflight,
} from "./materialized-view-maintenance.ts";
import { main } from "./run-materialized-view-maintenance.ts";
import { syncMaterializedViews } from "./sync-views.ts";

const mockRunQuietDatabasePreflight = vi.mocked(runQuietDatabasePreflight);
const mockRefreshMaterializedViewForMaintenance = vi.mocked(refreshMaterializedViewForMaintenance);
const mockSyncMaterializedViews = vi.mocked(syncMaterializedViews);

describe("run-materialized-view-maintenance main()", () => {
  const originalArguments = process.argv;
  const originalUrl = process.env.DATABASE_URL;
  const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  beforeEach(() => {
    process.argv = ["node", "run-materialized-view-maintenance.ts"];
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockRunQuietDatabasePreflight.mockReset();
    mockRefreshMaterializedViewForMaintenance.mockReset();
    mockSyncMaterializedViews.mockReset();
    mockClientConnect.mockClear();
    mockClientEnd.mockClear();
    mockClientConstructor.mockClear();
    stdoutWriteSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArguments;
    if (originalUrl) {
      process.env.DATABASE_URL = originalUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("prints the concurrent-refresh inventory without connecting", async () => {
    process.argv.push("inventory");

    await main();

    expect(mockClientConstructor).not.toHaveBeenCalled();
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "fitness.v_daily_metrics\tmedium\tv_daily_metrics_date_idx\tDaily metric priority view.\n",
    );
  });

  it("runs quiet database preflight and exits nonzero on failures", async () => {
    process.argv.push("preflight");
    mockRunQuietDatabasePreflight.mockResolvedValue({
      activeMaintenanceQueryCount: 0,
      failures: ["database is in recovery"],
      lockWaitCount: 0,
      ok: false,
      warnings: [],
    });

    await expect(main()).rejects.toThrow("quiet database preflight failed");
    expect(mockClientConnect).toHaveBeenCalled();
    expect(mockClientEnd).toHaveBeenCalled();
  });

  it("runs a blocking maintenance refresh command", async () => {
    process.argv.push("refresh", "fitness.v_daily_metrics");
    mockRefreshMaterializedViewForMaintenance.mockResolvedValue({
      durationMs: 12,
      finishedAt: new Date("2026-04-26T12:01:00.000Z"),
      mode: "concurrent",
      startedAt: new Date("2026-04-26T12:00:00.000Z"),
      viewName: "fitness.v_daily_metrics",
      warnings: [],
    });

    await main();

    expect(mockRefreshMaterializedViewForMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ connect: expect.any(Function) }),
      "fitness.v_daily_metrics",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "refreshed=fitness.v_daily_metrics mode=concurrent duration_ms=12\n",
    );
  });

  it("runs blocking materialized view sync after preflight", async () => {
    process.argv.push("sync");
    mockRunQuietDatabasePreflight.mockResolvedValue({
      activeMaintenanceQueryCount: 0,
      failures: [],
      lockWaitCount: 0,
      ok: true,
      warnings: [],
    });
    mockSyncMaterializedViews.mockResolvedValue({ refreshed: 1, skipped: 6, synced: 0 });

    await main();

    expect(mockRunQuietDatabasePreflight).toHaveBeenCalled();
    expect(mockSyncMaterializedViews).toHaveBeenCalledWith(
      "postgres://test:test@localhost:5432/test",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith("synced=0 skipped=6 refreshed=1\n");
  });
});
