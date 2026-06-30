import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import type { ReadinessDependencies } from "./readiness.ts";

const mockCheckWorkerQueues = vi.fn(async () => ({ status: "ok" as const, queues: "ok" as const }));
const mockDbExecute = vi.fn(async () => [{ ok: 1 }]);

vi.mock("../../../../src/jobs/worker-health.ts", () => ({
  checkWorkerQueues: mockCheckWorkerQueues,
}));

const { checkReadiness } = await import("./readiness.ts");

describe("checkReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckWorkerQueues.mockResolvedValue({ status: "ok", queues: "ok" });
    mockDbExecute.mockResolvedValue([{ ok: 1 }]);
  });

  it("returns ready when Postgres, ClickHouse, and queues are reachable", async () => {
    const sensorStore = makeMockSensorStore([{ ok: 1 }]);
    const db = { execute: mockDbExecute } satisfies ReadinessDependencies["db"];

    const result = await checkReadiness({ db, sensorStore });

    expect(result).toEqual({
      status: "ok",
      checks: {
        postgres: "ok",
        clickhouse: "ok",
        queues: "ok",
      },
    });
    expect(mockDbExecute).toHaveBeenCalled();
    expect(sensorStore.query).toHaveBeenCalled();
    expect(mockCheckWorkerQueues).toHaveBeenCalled();
  });

  it("returns unavailable when Postgres fails without skipping other checks", async () => {
    mockDbExecute.mockRejectedValueOnce(new Error("database offline"));
    const sensorStore = makeMockSensorStore([{ ok: 1 }]);
    const db = { execute: mockDbExecute } satisfies ReadinessDependencies["db"];

    const result = await checkReadiness({ db, sensorStore });

    expect(result).toEqual({
      status: "error",
      checks: {
        postgres: "error",
        clickhouse: "ok",
        queues: "ok",
      },
    });
    expect(sensorStore.query).toHaveBeenCalled();
    expect(mockCheckWorkerQueues).toHaveBeenCalled();
  });

  it("returns unavailable when ClickHouse fails", async () => {
    const sensorStore = makeMockSensorStore([]);
    vi.mocked(sensorStore.query).mockRejectedValueOnce(new Error("clickhouse offline"));
    const db = { execute: mockDbExecute } satisfies ReadinessDependencies["db"];

    const result = await checkReadiness({ db, sensorStore });

    expect(result).toEqual({
      status: "error",
      checks: {
        postgres: "ok",
        clickhouse: "error",
        queues: "ok",
      },
    });
  });

  it("returns unavailable when worker queues fail", async () => {
    mockCheckWorkerQueues.mockRejectedValueOnce(new Error("redis offline"));
    const sensorStore = makeMockSensorStore([{ ok: 1 }]);
    const db = { execute: mockDbExecute } satisfies ReadinessDependencies["db"];

    const result = await checkReadiness({ db, sensorStore });

    expect(result).toEqual({
      status: "error",
      checks: {
        postgres: "ok",
        clickhouse: "ok",
        queues: "error",
      },
    });
  });
});
