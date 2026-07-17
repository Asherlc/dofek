import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  ACTIVITY_DELETE_DBT_SELECT,
  type ActivityReadModelSpawner,
  countActivePeerDbActivities,
  countProviderAbsentPeerDbActivities,
  runActivityReadModelBuild,
  runProviderDeleteReadModelBuild,
  type SpawnedProcess,
  waitForMetricStreamProviderDeletes,
  waitForPeerDbActivityDeletes,
  waitForPeerDbActivityRestores,
  waitForPeerDbProviderDeletes,
} from "./activity-read-model-build.ts";

function createMockClickHouseClient(query: Mock): ClickHouseClient {
  return {
    command: vi.fn(),
    query,
  };
}

function createMockChildProcess(): SpawnedProcess {
  return Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
  });
}

describe("activity-read-model-build", () => {
  it("returns zero without querying when no activity ids are provided", async () => {
    const query = vi.fn();
    const client = createMockClickHouseClient(query);

    await expect(countActivePeerDbActivities(client, [])).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("counts active mirrored activities for the requested ids", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ active_count: 1 }]),
      }),
    );

    await expect(
      countActivePeerDbActivities(client, ["00000000-0000-0000-0000-000000000001"]),
    ).resolves.toBe(1);
  });

  it("passes activity ids to the PeerDB count query", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ active_count: 2 }]),
    });
    const client = createMockClickHouseClient(query);

    await countActivePeerDbActivities(client, ["id-1", "id-2"]);

    expect(query).toHaveBeenCalledWith({
      query: expect.stringContaining("deleted_at IS NULL"),
      format: "JSONEachRow",
      query_params: { activityIds: ["id-1", "id-2"] },
    });
  });

  it("returns zero when the count query returns no rows", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      }),
    );

    await expect(countActivePeerDbActivities(client, ["id-1"])).resolves.toBe(0);
  });

  it("returns zero without querying when no absent activity ids are provided", async () => {
    const query = vi.fn();
    const client = createMockClickHouseClient(query);

    await expect(countProviderAbsentPeerDbActivities(client, [])).resolves.toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("counts provider-absent mirrored activities for the requested ids", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ absent_count: 1 }]),
      }),
    );

    await expect(
      countProviderAbsentPeerDbActivities(client, ["00000000-0000-0000-0000-000000000001"]),
    ).resolves.toBe(1);
  });

  it("passes activity ids to the provider-absent PeerDB count query", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ absent_count: 2 }]),
    });
    const client = createMockClickHouseClient(query);

    await countProviderAbsentPeerDbActivities(client, ["id-1", "id-2"]);

    expect(query).toHaveBeenCalledWith({
      query: expect.stringContaining("provider_absent_at IS NOT NULL"),
      format: "JSONEachRow",
      query_params: { activityIds: ["id-1", "id-2"] },
    });
  });

  it("returns zero when the provider-absent count query returns no rows", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      }),
    );

    await expect(countProviderAbsentPeerDbActivities(client, ["id-1"])).resolves.toBe(0);
  });

  it("returns immediately when no activity ids need waiting", async () => {
    const query = vi.fn();
    const client = createMockClickHouseClient(query);

    await expect(waitForPeerDbActivityDeletes(client, [])).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("waits until PeerDB no longer reports deleted activities as active", async () => {
    const client = createMockClickHouseClient(
      vi
        .fn()
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 1 }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 0 }]) }),
    );

    await expect(
      waitForPeerDbActivityDeletes(client, ["00000000-0000-0000-0000-000000000001"], {
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });

  it("deduplicates activity ids while waiting for PeerDB", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ active_count: 0 }]),
    });
    const client = createMockClickHouseClient(query);

    await waitForPeerDbActivityDeletes(client, ["id-1", "id-1"]);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { activityIds: ["id-1"] },
      }),
    );
  });

  it("throws when PeerDB deletes are not reflected before timeout", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ active_count: 1 }]),
      }),
    );

    await expect(
      waitForPeerDbActivityDeletes(client, ["id-1"], { pollIntervalMs: 0, timeoutMs: 1 }),
    ).rejects.toThrow("Timed out waiting for PeerDB to reflect deletion of 1 activities");
  });

  it("returns immediately when no restored activity ids need waiting", async () => {
    const query = vi.fn();
    const client = createMockClickHouseClient(query);

    await expect(waitForPeerDbActivityRestores(client, [])).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("waits until PeerDB no longer reports restored activities as provider-absent", async () => {
    const client = createMockClickHouseClient(
      vi
        .fn()
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ absent_count: 1 }]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ absent_count: 0 }]) }),
    );

    await expect(
      waitForPeerDbActivityRestores(client, ["00000000-0000-0000-0000-000000000001"], {
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });

  it("deduplicates activity ids while waiting for PeerDB restores", async () => {
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ absent_count: 0 }]),
    });
    const client = createMockClickHouseClient(query);

    await waitForPeerDbActivityRestores(client, ["id-1", "id-1"]);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { activityIds: ["id-1"] },
      }),
    );
  });

  it("throws when PeerDB restores are not reflected before timeout", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ absent_count: 1 }]),
      }),
    );

    await expect(
      waitForPeerDbActivityRestores(client, ["id-1"], { pollIntervalMs: 0, timeoutMs: 1 }),
    ).rejects.toThrow("Timed out waiting for PeerDB to reflect restoration of 1 activities");
  });

  it("runs the activity delete dbt model chain", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn<ActivityReadModelSpawner>().mockReturnValue(child);

    const buildPromise = runActivityReadModelBuild(spawnImpl);
    child.emit("close", 0);

    await expect(buildPromise).resolves.toBeUndefined();
    expect(spawnImpl).toHaveBeenCalledWith(
      "dbt",
      [
        "build",
        "--project-dir",
        "analytics",
        "--profiles-dir",
        "analytics",
        "--threads",
        "1",
        "--select",
        ACTIVITY_DELETE_DBT_SELECT,
      ],
      {
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  });

  it("waits until provider metric-stream tombstones are visible in ClickHouse", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 2 }]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 0 }]) });
    const client = createMockClickHouseClient(query);

    await waitForMetricStreamProviderDeletes(client, "user-1", "strava", {
      pollIntervalMs: 0,
      timeoutMs: 100,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        query_params: { userId: "user-1", providerId: "strava" },
      }),
    );
  });

  it("waits until every provider-scoped Postgres source is deleted in ClickHouse", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 3 }]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 0 }]) });
    const client = createMockClickHouseClient(query);

    await waitForPeerDbProviderDeletes(client, "user-1", "strava", {
      pollIntervalMs: 0,
      timeoutMs: 100,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ query_params: { userId: "user-1", providerId: "strava" } }),
    );
    expect(query.mock.calls[0]?.[0].query).toContain("postgres_fitness.daily_metrics FINAL");
    expect(query.mock.calls[0]?.[0].query).toContain("postgres_fitness.journal_entry FINAL");
  });

  it("runs every incremental dbt model after provider deletion", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn<ActivityReadModelSpawner>().mockReturnValue(child);

    const buildPromise = runProviderDeleteReadModelBuild(spawnImpl);
    child.emit("close", 0);

    await expect(buildPromise).resolves.toBeUndefined();
    expect(spawnImpl).toHaveBeenCalledWith(
      "dbt",
      ["build", "--project-dir", "analytics", "--profiles-dir", "analytics", "--threads", "1"],
      { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
    );
  });

  it("rejects when dbt exits with a non-zero status", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn<ActivityReadModelSpawner>().mockReturnValue(child);

    const buildPromise = runActivityReadModelBuild(spawnImpl);
    child.emit("close", 1);

    await expect(buildPromise).rejects.toThrow(
      `dbt build --select ${ACTIVITY_DELETE_DBT_SELECT} failed with exit code 1`,
    );
  });

  it("includes trimmed stderr in dbt failure errors", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn<ActivityReadModelSpawner>().mockReturnValue(child);

    const buildPromise = runActivityReadModelBuild(spawnImpl);
    if (child.stderr instanceof PassThrough) {
      child.stderr.write("  model failed  ");
    }
    child.emit("close", 2);

    await expect(buildPromise).rejects.toThrow(": model failed");
  });

  it("rejects when spawning dbt fails", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn<ActivityReadModelSpawner>().mockReturnValue(child);

    const buildPromise = runActivityReadModelBuild(spawnImpl);
    const spawnError = new Error("dbt not found");
    child.emit("error", spawnError);

    await expect(buildPromise).rejects.toThrow("dbt not found");
  });
});
