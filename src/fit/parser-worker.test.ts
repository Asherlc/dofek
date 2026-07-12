import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedFitActivity } from "./parser.ts";

const fixturesPath = resolve(import.meta.dirname, "fixtures");
const originalExecArgv = [...process.execArgv];

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(fixturesPath, name));
}

class MockWorker extends EventEmitter {
  static instances: MockWorker[] = [];

  readonly filename: string | URL;
  readonly options: WorkerOptions;
  readonly terminate = vi.fn<() => Promise<number>>(() => Promise.resolve(0));

  constructor(filename: string | URL, options: WorkerOptions = {}) {
    super();
    this.filename = filename;
    this.options = options;
    MockWorker.instances.push(this);
  }
}

function parsedFitActivityFixture(): ParsedFitActivity {
  return {
    session: {
      sport: "cycling",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      totalElapsedTime: 1,
      totalTimerTime: 1,
      totalDistance: 1,
      totalCalories: 1,
      raw: {},
    },
    records: [],
    laps: [],
    events: [],
  };
}

async function importParserWorkerWithMockWorker(): Promise<typeof import("./parser-worker.ts")> {
  vi.resetModules();
  MockWorker.instances = [];
  vi.doMock("node:worker_threads", () => ({ Worker: MockWorker }));
  return import("./parser-worker.ts");
}

async function importParserWorkerWithRealWorker(): Promise<typeof import("./parser-worker.ts")> {
  vi.resetModules();
  vi.doUnmock("node:worker_threads");
  return import("./parser-worker.ts");
}

afterEach(() => {
  process.execArgv = [...originalExecArgv];
  vi.useRealTimers();
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("parseFitFileInWorkerThread", () => {
  it("parses a FIT file in a worker thread", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithRealWorker();

    const result = await parseFitFileInWorkerThread(loadFixture("test.fit"));

    expect(result.session.sport).toBe("cycling");
    expect(result.records.length).toBe(3229);
  });

  it("resolves the parsed activity from a valid worker message", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();
    const activity = parsedFitActivityFixture();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("message", { status: "ok", activity });

    await expect(resultPromise).resolves.toStrictEqual(activity);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  });

  it("propagates parser errors returned by the worker", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("message", {
      status: "error",
      message: "worker parser failed",
      stack: "Error: worker parser failed",
    });

    await expect(resultPromise).rejects.toThrow("worker parser failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects invalid worker messages", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("message", { status: "ok", activity: null });

    await expect(resultPromise).rejects.toThrow(/invalid message/i);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects malformed parsed activity messages", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("message", { status: "ok", activity: { session: { sport: "cycling" } } });

    await expect(resultPromise).rejects.toThrow(/invalid message/i);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects worker error events", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("error", new Error("worker thread crashed"));

    await expect(resultPromise).rejects.toThrow("worker thread crashed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects non-zero worker exits", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("exit", 1);

    await expect(resultPromise).rejects.toThrow("FIT parser worker exited with code 1");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects clean worker exits that do not send a message", async () => {
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("exit", 0);

    await expect(resultPromise).rejects.toThrow(
      "FIT parser worker exited without sending a message",
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects and terminates workers that time out", async () => {
    vi.useFakeTimers();
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    vi.advanceTimersByTime(120_000);

    await expect(resultPromise).rejects.toThrow("FIT parser worker timed out after 120000ms");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  });

  it("removes loader imports from worker exec arguments", async () => {
    process.execArgv = [
      "--inspect=127.0.0.1:9229",
      "--import",
      "data:text/javascript,throw%20new%20Error(%22strip-me%22)",
      "--import=data:text/javascript,throw%20new%20Error(%22strip-me-too%22)",
      "--conditions=development",
    ];
    const { parseFitFileInWorkerThread } = await importParserWorkerWithMockWorker();

    const resultPromise = parseFitFileInWorkerThread(Buffer.from("fit"));
    const worker = expectWorkerInstance();
    worker.emit("message", { status: "ok", activity: parsedFitActivityFixture() });

    await expect(resultPromise).resolves.toBeDefined();
    expect(worker.options.execArgv).toEqual([
      "--inspect=127.0.0.1:9229",
      "--conditions=development",
    ]);
  });
});

function expectWorkerInstance(): MockWorker {
  const worker = MockWorker.instances[0];
  if (worker === undefined) {
    throw new Error("Expected a mock worker instance");
  }
  return worker;
}
