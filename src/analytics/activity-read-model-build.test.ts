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
  waitForPeerDbActivityDeletes,
  waitForPeerDbActivityRestores,
} from "./activity-read-model-build.ts";

function createMockClickHouseClient(query: Mock): ClickHouseClient {
  return {
    command: vi.fn(),
    query,
  };
}

function createMockChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
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
        stdio: ["ignore", "pipe", "pipe"],
      },
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

  it("includes dbt stdout diagnostics in failure errors", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn<ActivityReadModelSpawner>().mockReturnValue(child);

    const buildPromise = runActivityReadModelBuild(spawnImpl);
    if (child.stdout instanceof PassThrough) {
      child.stdout.write("  Database Error in model activity_source_records  ");
    }
    child.emit("close", 2);

    await expect(buildPromise).rejects.toThrow("Database Error in model activity_source_records");
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
