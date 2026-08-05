import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { createWorkerReadinessServer } from "./worker-readiness.ts";

vi.mock("../lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

interface TestWorker {
  name: string;
  isRunning(): boolean;
  client: Promise<{ status: string; llen(key: string): Promise<number> }>;
  toKey(type: string): string;
  waitUntilReady(): Promise<{ status: string }>;
}

const openServers: ReturnType<typeof createWorkerReadinessServer>[] = [];

async function startReadinessServer(workers: TestWorker[]): Promise<string> {
  const server = createWorkerReadinessServer(workers);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker readiness server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function requestReadiness(
  workers: TestWorker[],
  path = "/readyz",
  method = "GET",
): Promise<Response> {
  const serverUrl = await startReadinessServer(workers);
  return fetch(`${serverUrl}${path}`, { method });
}

function makeWorker(
  name: string,
  options: {
    running?: boolean;
    blockingStatus?: string;
    commandStatus?: string;
    listLength?: (key: string) => Promise<number>;
  } = {},
): TestWorker {
  const commandClient = {
    status: options.commandStatus ?? "ready",
    llen: (key: string) => options.listLength?.(key) ?? Promise.resolve(0),
  };
  return {
    name,
    isRunning: () => options.running ?? true,
    get client() {
      return Promise.resolve(commandClient);
    },
    toKey: (type) => `bull:${name}:${type}`,
    waitUntilReady: () => Promise.resolve({ status: options.blockingStatus ?? "ready" }),
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("createWorkerReadinessServer", () => {
  it("reports ready using the existing clients of every running worker", async () => {
    const firstListLength = vi.fn(() => Promise.resolve(0));
    const secondListLength = vi.fn(() => Promise.resolve(1));
    const firstWorker = makeWorker("sync", { listLength: firstListLength });
    const secondWorker = makeWorker("import", { listLength: secondListLength });
    const firstCommand = vi.spyOn(await firstWorker.client, "llen");
    const secondCommand = vi.spyOn(await secondWorker.client, "llen");

    const response = await requestReadiness([firstWorker, secondWorker]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ status: "ok", workers: 2 });
    expect(firstListLength).toHaveBeenCalledWith("bull:sync:wait");
    expect(secondListLength).toHaveBeenCalledWith("bull:import:wait");
    expect(firstCommand).toHaveBeenCalledWith("bull:sync:wait");
    expect(secondCommand).toHaveBeenCalledWith("bull:import:wait");
  });

  it("clears the readiness timeout after a fast successful check", async () => {
    const serverUrl = await startReadinessServer([makeWorker("sync")]);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const response = await fetch(`${serverUrl}/readyz`);

    expect(response.status).toBe(200);
    const readinessTimeoutIndex = setTimeoutSpy.mock.calls.findIndex(
      ([, timeoutMs]) => timeoutMs === 2_500,
    );
    expect(readinessTimeoutIndex).toBeGreaterThanOrEqual(0);
    const readinessTimeoutId = setTimeoutSpy.mock.results[readinessTimeoutIndex]?.value;
    expect(clearTimeoutSpy).toHaveBeenCalledWith(readinessTimeoutId);
  });

  it("reports unavailable when a worker is not running", async () => {
    const listLength = vi.fn(() => Promise.resolve(0));

    const response = await requestReadiness([
      makeWorker("sync", { running: false, listLength }),
      makeWorker("import"),
    ]);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(listLength).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "BullMQ worker is not running: sync" }),
    );
  });

  it("reports unavailable when an existing worker client cannot reach Redis", async () => {
    const redisError = new Error("redis offline");

    const response = await requestReadiness([
      makeWorker("sync", { listLength: () => Promise.reject(redisError) }),
    ]);

    expect(response.status).toBe(503);
    expect(captureException).toHaveBeenCalledWith(redisError);
    expect(logger.error).toHaveBeenCalledWith("[worker] Readiness check failed: redis offline");
  });

  it("reports unavailable when a worker blocking connection is not ready", async () => {
    const listLength = vi.fn(() => Promise.resolve(0));

    const response = await requestReadiness([
      makeWorker("sync", { blockingStatus: "wait", listLength }),
    ]);

    expect(response.status).toBe(503);
    expect(listLength).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[worker] Readiness check failed: BullMQ worker blocking connection (sync) is not ready",
    );
  });

  it("reports unavailable without queueing a command when a command client is reconnecting", async () => {
    const listLength = vi.fn(() => Promise.resolve(0));

    const response = await requestReadiness([
      makeWorker("sync", { commandStatus: "reconnecting", listLength }),
    ]);

    expect(response.status).toBe(503);
    expect(listLength).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[worker] Readiness check failed: BullMQ worker command connection (sync) is not ready",
    );
  });

  it("succeeds when blocking connection becomes ready after retries", async () => {
    let callCount = 0;
    const worker: TestWorker = {
      name: "sync",
      isRunning: () => true,
      get client() {
        return Promise.resolve({
          status: "ready",
          llen: () => Promise.resolve(0),
        });
      },
      toKey: (type) => `bull:sync:${type}`,
      waitUntilReady: () => {
        callCount++;
        return Promise.resolve({ status: callCount < 3 ? "reconnecting" : "ready" });
      },
    };

    const response = await requestReadiness([worker]);

    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
  });

  it("retries exactly CONNECTION_STATUS_RETRIES times and applies correct delays", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let callCount = 0;
    const worker: TestWorker = {
      name: "sync",
      isRunning: () => true,
      get client() {
        return Promise.resolve({
          status: "ready",
          llen: () => Promise.resolve(0),
        });
      },
      toKey: (type) => `bull:sync:${type}`,
      waitUntilReady: () => {
        callCount++;
        return Promise.resolve({ status: "reconnecting" });
      },
    };

    const response = await requestReadiness([worker]);

    expect(response.status).toBe(503);
    expect(callCount).toBe(3);
    const readinessDelays = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 200);
    expect(readinessDelays).toHaveLength(2);
  });

  it("retries when getStatus throws an error", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let callCount = 0;
    const worker: TestWorker = {
      name: "sync",
      isRunning: () => true,
      get client() {
        return Promise.resolve({
          status: "ready",
          llen: () => Promise.resolve(0),
        });
      },
      toKey: (type) => `bull:sync:${type}`,
      waitUntilReady: () => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error("blocking connection is not ready"));
        }
        return Promise.resolve({ status: "ready" });
      },
    };

    const response = await requestReadiness([worker]);

    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
    const readinessDelays = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 200);
    expect(readinessDelays).toHaveLength(2);
  });

  it("reports unavailable when a Redis readiness command does not settle", async () => {
    let markCommandStarted: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const serverUrl = await startReadinessServer([
      makeWorker("sync", {
        listLength: () => {
          markCommandStarted?.();
          return new Promise<number>(() => undefined);
        },
      }),
    ]);
    vi.useFakeTimers();

    const responsePromise = fetch(`${serverUrl}/readyz`);
    await commandStarted;
    await vi.advanceTimersByTimeAsync(2_500);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(captureException).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[worker] Readiness check failed: Worker readiness timed out after 2500ms",
    );
  }, 1_000);

  it("does not start another Redis command while a timed-out check is still pending", async () => {
    let markCommandStarted: (() => void) | undefined;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const listLength = vi.fn(() => {
      markCommandStarted?.();
      return new Promise<number>(() => undefined);
    });
    const serverUrl = await startReadinessServer([makeWorker("sync", { listLength })]);
    vi.useFakeTimers();

    const firstResponsePromise = fetch(`${serverUrl}/readyz`);
    await commandStarted;
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await firstResponsePromise).status).toBe(503);

    const secondResponsePromise = fetch(`${serverUrl}/readyz`);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await secondResponsePromise).status).toBe(503);
    expect(listLength).toHaveBeenCalledOnce();
  }, 1_000);

  it("does not expose readiness on unrelated paths", async () => {
    const response = await requestReadiness([makeWorker("sync")], "/healthz");

    expect(response.status).toBe(404);
  });

  it("does not run readiness checks for non-GET requests", async () => {
    const listLength = vi.fn(() => Promise.resolve(0));

    const response = await requestReadiness(
      [makeWorker("sync", { listLength })],
      "/readyz",
      "POST",
    );

    expect(response.status).toBe(404);
    expect(listLength).not.toHaveBeenCalled();
  });
});
