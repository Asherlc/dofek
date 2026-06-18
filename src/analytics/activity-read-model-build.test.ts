import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  ACTIVITY_DELETE_DBT_SELECT,
  type ActivityReadModelSpawner,
  countActivePeerDbActivities,
  runActivityReadModelBuild,
  type SpawnedProcess,
  waitForPeerDbActivityDeletes,
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
      query: expect.stringContaining("postgres_fitness.activity FINAL"),
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
