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
  cancelInProgressMaterializedViewRefreshesForMaintenance: vi.fn(),
  rebuildMaterializedViewForMaintenance: vi.fn(),
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
  cancelInProgressMaterializedViewRefreshesForMaintenance,
  rebuildMaterializedViewForMaintenance,
  refreshMaterializedViewForMaintenance,
  runQuietDatabasePreflight,
} from "./materialized-view-maintenance.ts";
import { main } from "./run-materialized-view-maintenance.ts";
import { syncMaterializedViews } from "./sync-views.ts";

const mockRunQuietDatabasePreflight = vi.mocked(runQuietDatabasePreflight);
const mockRefreshMaterializedViewForMaintenance = vi.mocked(refreshMaterializedViewForMaintenance);
const mockRebuildMaterializedViewForMaintenance = vi.mocked(rebuildMaterializedViewForMaintenance);
const mockCancelInProgressMaterializedViewRefreshesForMaintenance = vi.mocked(
  cancelInProgressMaterializedViewRefreshesForMaintenance,
);
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
    mockRebuildMaterializedViewForMaintenance.mockReset();
    mockCancelInProgressMaterializedViewRefreshesForMaintenance.mockReset();
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

  it("prints usage for help commands without connecting", async () => {
    for (const helpCommand of [undefined, "help", "--help", "-h"]) {
      process.argv = ["node", "run-materialized-view-maintenance.ts"];
      if (helpCommand) {
        process.argv.push(helpCommand);
      }
      mockClientConstructor.mockClear();
      stdoutWriteSpy.mockClear();

      await main();

      expect(mockClientConstructor).not.toHaveBeenCalled();
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: pnpm tsx src/db/run-materialized-view-maintenance.ts"),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("rebuild <view-name>"));
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining("cancel-refreshes <view-name>"),
      );
    }
  });

  it("requires DATABASE_URL for database-backed commands", async () => {
    process.argv.push("preflight");
    delete process.env.DATABASE_URL;

    await expect(main()).rejects.toThrow("DATABASE_URL environment variable is required");

    expect(mockClientConstructor).not.toHaveBeenCalled();
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

  it("prints preflight warnings before reporting ok", async () => {
    process.argv.push("preflight");
    mockRunQuietDatabasePreflight.mockResolvedValue({
      activeMaintenanceQueryCount: 1,
      failures: [],
      lockWaitCount: 0,
      ok: true,
      warnings: ["1 long-running maintenance-like query is active"],
    });

    await main();

    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "warning=1 long-running maintenance-like query is active\n",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith("ok=true\n");
  });

  it("requires a view name for refresh", async () => {
    process.argv.push("refresh");

    await expect(main()).rejects.toThrow("refresh requires a view name");

    expect(mockRefreshMaterializedViewForMaintenance).not.toHaveBeenCalled();
    expect(mockClientEnd).toHaveBeenCalledOnce();
  });

  it("runs a blocking maintenance refresh command", async () => {
    process.argv.push("refresh", "fitness.v_daily_metrics");
    mockRefreshMaterializedViewForMaintenance.mockResolvedValue({
      durationMs: 12,
      finishedAt: new Date("2026-04-26T12:01:00.000Z"),
      mode: "concurrent",
      startedAt: new Date("2026-04-26T12:00:00.000Z"),
      viewName: "fitness.v_daily_metrics",
      warnings: ["1 long-running maintenance-like query is active"],
    });

    await main();

    expect(mockRefreshMaterializedViewForMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ connect: expect.any(Function) }),
      "fitness.v_daily_metrics",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "warning=1 long-running maintenance-like query is active\n",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "refreshed=fitness.v_daily_metrics mode=concurrent duration_ms=12\n",
    );
  });

  it("requires a view name for rebuild", async () => {
    process.argv.push("rebuild");

    await expect(main()).rejects.toThrow("rebuild requires a view name");

    expect(mockRebuildMaterializedViewForMaintenance).not.toHaveBeenCalled();
    expect(mockClientEnd).toHaveBeenCalledOnce();
  });

  it("requires a view name for cancel-refreshes", async () => {
    process.argv.push("cancel-refreshes");

    await expect(main()).rejects.toThrow("cancel-refreshes requires a view name");

    expect(mockCancelInProgressMaterializedViewRefreshesForMaintenance).not.toHaveBeenCalled();
    expect(mockClientEnd).toHaveBeenCalledOnce();
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
    expect(mockClientEnd).toHaveBeenCalledOnce();
    expect(stdoutWriteSpy).toHaveBeenCalledWith("synced=0 skipped=6 refreshed=1\n");
  });

  it("prints sync preflight warnings and exits nonzero on failures", async () => {
    process.argv.push("sync");
    mockRunQuietDatabasePreflight.mockResolvedValue({
      activeMaintenanceQueryCount: 1,
      failures: ["1 lock wait is active"],
      lockWaitCount: 1,
      ok: false,
      warnings: ["1 long-running maintenance-like query is active"],
    });

    await expect(main()).rejects.toThrow("quiet database preflight failed: 1 lock wait is active");

    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "warning=1 long-running maintenance-like query is active\n",
    );
    expect(mockSyncMaterializedViews).not.toHaveBeenCalled();
    expect(mockClientEnd).toHaveBeenCalledOnce();
  });

  it("runs a blocking materialized view rebuild command", async () => {
    process.argv.push("rebuild", "fitness.v_daily_metrics");
    mockRebuildMaterializedViewForMaintenance.mockResolvedValue({
      durationMs: 35,
      finishedAt: new Date("2026-04-26T12:01:00.000Z"),
      mode: "rebuild",
      startedAt: new Date("2026-04-26T12:00:00.000Z"),
      viewName: "fitness.v_daily_metrics",
      warnings: ["1 long-running maintenance-like query is active"],
    });

    await main();

    expect(mockRebuildMaterializedViewForMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ connect: expect.any(Function) }),
      "fitness.v_daily_metrics",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "warning=1 long-running maintenance-like query is active\n",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "rebuilt=fitness.v_daily_metrics mode=rebuild duration_ms=35\n",
    );
  });

  it("runs a target refresh cancellation command", async () => {
    process.argv.push("cancel-refreshes", "fitness.v_daily_metrics");
    mockCancelInProgressMaterializedViewRefreshesForMaintenance.mockResolvedValue({
      viewName: "fitness.v_daily_metrics",
      warnings: ["canceled 1 in-progress refresh for fitness.v_daily_metrics"],
    });

    await main();

    expect(mockCancelInProgressMaterializedViewRefreshesForMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({ connect: expect.any(Function) }),
      "fitness.v_daily_metrics",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith(
      "warning=canceled 1 in-progress refresh for fitness.v_daily_metrics\n",
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith("canceled_refreshes=fitness.v_daily_metrics\n");
  });

  it("throws usage for unknown commands", async () => {
    process.argv.push("unknown");

    await expect(main()).rejects.toThrow("unknown command: unknown");

    expect(mockClientEnd).toHaveBeenCalledOnce();
  });
});
