import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadinessDependencies } from "./readiness.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const mockCheckWorkerQueues = vi.fn(async () => ({ status: "ok" as const, queues: "ok" as const }));
const mockDbExecute = vi.fn(async () => [{ inRecovery: false }]);

vi.mock("../../../../src/jobs/worker-health.ts", () => ({
  checkWorkerQueues: mockCheckWorkerQueues,
}));

const { checkReadiness } = await import("./readiness.ts");

describe("checkReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockCheckWorkerQueues.mockResolvedValue({ status: "ok", queues: "ok" });
    mockDbExecute.mockResolvedValue([{ inRecovery: false }]);
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

  it("returns unavailable when dependencies stall past the readiness timeout", async () => {
    vi.useFakeTimers();
    mockDbExecute.mockImplementationOnce(() => new Promise<never>(() => undefined));
    mockCheckWorkerQueues.mockImplementationOnce(() => new Promise<never>(() => undefined));
    const sensorStore = makeMockSensorStore([{ ok: 1 }]);
    let clickHouseAbortSignal: AbortSignal | undefined;
    vi.mocked(sensorStore.query).mockImplementationOnce(
      (_schema, _query, _params, options) =>
        new Promise<never>((_resolve, reject) => {
          clickHouseAbortSignal = options?.abortSignal;
          clickHouseAbortSignal?.addEventListener("abort", () => {
            reject(new Error("ClickHouse readiness query aborted"));
          });
        }),
    );
    const db = { execute: mockDbExecute } satisfies ReadinessDependencies["db"];

    const resultPromise = checkReadiness({ db, sensorStore });
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(resultPromise).resolves.toEqual({
      status: "error",
      checks: {
        postgres: "error",
        clickhouse: "error",
        queues: "error",
      },
    });
    expect(mockCheckWorkerQueues).toHaveBeenCalledWith({ timeoutMs: 2_500 });
    expect(clickHouseAbortSignal?.aborted).toBe(true);
  });

  it("returns unavailable when Postgres is in recovery", async () => {
    mockDbExecute.mockResolvedValueOnce([{ inRecovery: true }]);
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
