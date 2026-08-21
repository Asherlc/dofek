import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  ACTIVITY_DELETE_DBT_SELECT,
  type ActivityReadModelSpawner,
  countActivePeerDbActivities,
  countActivePeerDbProviderRows,
  countProviderAbsentPeerDbActivities,
  runActivityReadModelBuild,
  runProviderDeleteReadModelBuild,
  type SpawnedProcess,
  waitForMetricStreamDeleteAcknowledgement,
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
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

// The build functions await a temp `--target-path` before spawning, so emit process
// events from inside the spawner after its close/error listeners are attached.
function createDeferredSpawner(
  child: SpawnedProcess,
  act: (child: SpawnedProcess) => void,
): Mock<ActivityReadModelSpawner> {
  return vi.fn<ActivityReadModelSpawner>().mockImplementation(() => {
    queueMicrotask(() => act(child));
    return child;
  });
}

function readTargetPath(spawnImpl: Mock<ActivityReadModelSpawner>): string {
  const spawnArguments = spawnImpl.mock.calls[0]?.[1] ?? [];
  const targetPathIndex = spawnArguments.indexOf("--target-path");
  return String(spawnArguments[targetPathIndex + 1]);
}

describe("activity-read-model-build", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

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

  it("runs the activity delete dbt model chain in an isolated target path", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", 0));

    await expect(runActivityReadModelBuild(spawnImpl)).resolves.toBeUndefined();
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
        "--target-path",
        readTargetPath(spawnImpl),
        "--select",
        ACTIVITY_DELETE_DBT_SELECT,
      ],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(readTargetPath(spawnImpl)).toContain("dofek-dbt-delete-artifacts-");
  });

  it("captures dbt stdout when the activity build fails", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => {
      if (spawned.stdout instanceof PassThrough) {
        spawned.stdout.write("  Database Error in model activity_source_records  ");
      }
      spawned.emit("close", 2);
    });

    await expect(runActivityReadModelBuild(spawnImpl)).rejects.toThrow(
      `dbt build --select ${ACTIVITY_DELETE_DBT_SELECT} failed with exit code 2: Database Error in model activity_source_records`,
    );
  });

  it("uses a distinct dbt target path for each activity build", async () => {
    const firstChild = createMockChildProcess();
    const firstSpawn = createDeferredSpawner(firstChild, (spawned) => spawned.emit("close", 0));
    await runActivityReadModelBuild(firstSpawn);

    const secondChild = createMockChildProcess();
    const secondSpawn = createDeferredSpawner(secondChild, (spawned) => spawned.emit("close", 0));
    await runActivityReadModelBuild(secondSpawn);

    expect(readTargetPath(firstSpawn)).not.toEqual(readTargetPath(secondSpawn));
  });

  it("removes the dbt target directory after the activity build finishes", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", 0));

    await runActivityReadModelBuild(spawnImpl);

    expect(existsSync(readTargetPath(spawnImpl))).toBe(false);
  });

  it("removes the dbt target directory even when the activity build fails", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", 2));

    await expect(runActivityReadModelBuild(spawnImpl)).rejects.toThrow("exit code 2");

    expect(existsSync(readTargetPath(spawnImpl))).toBe(false);
  });

  it("waits until the metric-stream delete event is acknowledged by the ClickHouse sink", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ acknowledgement_count: 0 }]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ acknowledgement_count: 1 }]) });
    const client = createMockClickHouseClient(query);

    await waitForMetricStreamDeleteAcknowledgement(client, "30000000-0000-4000-8000-000000000001", {
      pollIntervalMs: 0,
      timeoutMs: 100,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        query_params: { eventId: "30000000-0000-4000-8000-000000000001" },
      }),
    );
  });

  it("treats a missing metric-stream acknowledgement row as zero", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ acknowledgement_count: 1 }]) });
    const client = createMockClickHouseClient(query);

    await waitForMetricStreamDeleteAcknowledgement(client, "event-1", {
      pollIntervalMs: 0,
      timeoutMs: 100,
    });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed metric-stream acknowledgement counts", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ acknowledgement_count: "invalid" }]),
      }),
    );

    await expect(
      waitForMetricStreamDeleteAcknowledgement(client, "event-1", {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("acknowledgement_count");
  });

  it("honors the metric-stream deletion timeout boundary", async () => {
    const query = vi.fn();
    const client = createMockClickHouseClient(query);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10);

    await expect(
      waitForMetricStreamDeleteAcknowledgement(client, "event-1", {
        pollIntervalMs: 0,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for ClickHouse");
    expect(query).not.toHaveBeenCalled();
  });

  it("waits for the configured interval before polling metric-stream deletes again", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ acknowledgement_count: 0 }]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ acknowledgement_count: 1 }]) });
    const client = createMockClickHouseClient(query);

    const waitPromise = waitForMetricStreamDeleteAcknowledgement(client, "event-1", {
      pollIntervalMs: 25,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waitPromise).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
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

  it("returns zero when the provider PeerDB count query returns no rows", async () => {
    const client = createMockClickHouseClient(
      vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }),
    );

    await expect(countActivePeerDbProviderRows(client, "user-1", "strava")).resolves.toBe(0);
  });

  it("honors the provider PeerDB deletion timeout boundary", async () => {
    const query = vi.fn();
    const client = createMockClickHouseClient(query);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(10);

    await expect(
      waitForPeerDbProviderDeletes(client, "user-1", "strava", {
        pollIntervalMs: 0,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for PeerDB");
    expect(query).not.toHaveBeenCalled();
  });

  it("waits for the configured interval before polling provider PeerDB deletes again", async () => {
    vi.useFakeTimers();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 1 }]) })
      .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ active_count: 0 }]) });
    const client = createMockClickHouseClient(query);

    const waitPromise = waitForPeerDbProviderDeletes(client, "user-1", "strava", {
      pollIntervalMs: 25,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waitPromise).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("runs every incremental dbt model in an isolated target path after provider deletion", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", 0));

    await expect(runProviderDeleteReadModelBuild(spawnImpl)).resolves.toBeUndefined();
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
        "--target-path",
        readTargetPath(spawnImpl),
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("captures dbt stdout when the provider analytics build fails", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => {
      if (spawned.stdout instanceof PassThrough) spawned.stdout.write("  provider model failed  ");
      spawned.emit("close", 2);
    });

    await expect(runProviderDeleteReadModelBuild(spawnImpl)).rejects.toThrow(
      "dbt build after provider deletion failed with exit code 2: provider model failed",
    );
  });

  it("reports an unknown provider analytics build exit status", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", null));

    await expect(runProviderDeleteReadModelBuild(spawnImpl)).rejects.toThrow("exit code unknown");
  });

  it("rejects when spawning the provider analytics build fails", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) =>
      spawned.emit("error", new Error("provider dbt not found")),
    );

    await expect(runProviderDeleteReadModelBuild(spawnImpl)).rejects.toThrow(
      "provider dbt not found",
    );
  });

  it("supports provider analytics child processes without captured streams", async () => {
    const child: SpawnedProcess = Object.assign(new EventEmitter(), {
      stdout: null,
      stderr: null,
    });
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", 0));

    await expect(runProviderDeleteReadModelBuild(spawnImpl)).resolves.toBeUndefined();
  });

  it("rejects when dbt exits with a non-zero status", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => spawned.emit("close", 1));

    await expect(runActivityReadModelBuild(spawnImpl)).rejects.toThrow(
      `dbt build --select ${ACTIVITY_DELETE_DBT_SELECT} failed with exit code 1`,
    );
  });

  it("captures dbt stderr in failure errors", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) => {
      if (spawned.stderr instanceof PassThrough) spawned.stderr.write("  model failed  ");
      spawned.emit("close", 2);
    });

    await expect(runActivityReadModelBuild(spawnImpl)).rejects.toThrow(": model failed");
  });

  it("rejects when spawning dbt fails", async () => {
    const child = createMockChildProcess();
    const spawnImpl = createDeferredSpawner(child, (spawned) =>
      spawned.emit("error", new Error("dbt not found")),
    );

    await expect(runActivityReadModelBuild(spawnImpl)).rejects.toThrow("dbt not found");
  });
});
