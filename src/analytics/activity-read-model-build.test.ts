import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  ACTIVITY_DELETE_DBT_SELECT,
  countActivePeerDbActivities,
  runActivityReadModelBuild,
  waitForPeerDbActivityDeletes,
} from "./activity-read-model-build.ts";

function createMockClickHouseClient(query: Mock): ClickHouseClient {
  return {
    command: vi.fn(),
    query,
  };
}

function createMockChildProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stderr: new Readable({ read() {} }),
  }) as ChildProcess;
}

describe("activity-read-model-build", () => {
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

  it("runs the activity delete dbt model chain", async () => {
    const child = createMockChildProcess();
    const spawnImpl = vi.fn().mockReturnValue(child);

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
      expect.objectContaining({ env: process.env }),
    );
  });
});
