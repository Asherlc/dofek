// cspell:ignore rollups
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClientConnect, mockClientEnd, mockClientQuery, mockClientConstructor } = vi.hoisted(
  () => {
    const clientInstance = {
      connect: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [{ refreshed_count: 3 }] }),
    };
    return {
      mockClientConnect: clientInstance.connect,
      mockClientConstructor: vi.fn(() => clientInstance),
      mockClientEnd: clientInstance.end,
      mockClientQuery: clientInstance.query,
    };
  },
);

vi.mock("pg", async (importOriginal) => {
  const original = await importOriginal<typeof import("pg")>();
  return { ...original, Client: mockClientConstructor };
});

import { main } from "./run-activity-rollups.ts";

function processExitWithError(): never {
  throw new Error("process.exit called");
}

describe("run-activity-rollups main()", () => {
  const originalArguments = process.argv;
  const originalUrl = process.env.DATABASE_URL;
  const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const processExitSpy = vi.spyOn(process, "exit").mockImplementation(processExitWithError);

  beforeEach(() => {
    process.argv = ["node", "run-activity-rollups.ts", "drain"];
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockClientConnect.mockClear();
    mockClientEnd.mockClear();
    mockClientQuery.mockClear();
    mockClientConstructor.mockClear();
    stdoutWriteSpy.mockClear();
    stderrWriteSpy.mockClear();
    processExitSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArguments;
    if (originalUrl !== undefined) {
      process.env.DATABASE_URL = originalUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("requires DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;

    await expect(main()).rejects.toThrow("DATABASE_URL");
  });

  it("drains dirty rollups with default batch size", async () => {
    await main();

    expect(mockClientQuery).toHaveBeenCalledWith(
      "SELECT analytics.refresh_dirty_activity_training_summaries($1) AS refreshed_count",
      [100],
    );
    expect(stdoutWriteSpy).toHaveBeenCalledWith("refreshed=3\n");
    expect(mockClientEnd).toHaveBeenCalled();
  });

  it("enqueues every canonical activity for backfill", async () => {
    process.argv = ["node", "run-activity-rollups.ts", "enqueue-backfill"];
    mockClientQuery.mockResolvedValueOnce({ rows: [{ queued_count: 42 }] });

    await main();

    expect(mockClientQuery).toHaveBeenCalledWith(expect.stringContaining("fitness.v_activity"));
    expect(stdoutWriteSpy).toHaveBeenCalledWith("queued=42\n");
  });

  it("prints usage without opening a database connection", async () => {
    process.argv = ["node", "run-activity-rollups.ts", "--help"];

    await main();

    expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("enqueue-backfill"));
    expect(mockClientConstructor).not.toHaveBeenCalled();
  });

  it("rejects unknown commands before opening a database connection", async () => {
    process.argv = ["node", "run-activity-rollups.ts", "rebuild"];

    await expect(main()).rejects.toThrow("unknown command: rebuild");

    expect(mockClientConstructor).not.toHaveBeenCalled();
  });

  it("drains dirty rollups with an explicit batch size", async () => {
    process.argv = ["node", "run-activity-rollups.ts", "drain", "250"];

    await main();

    expect(mockClientQuery).toHaveBeenCalledWith(
      "SELECT analytics.refresh_dirty_activity_training_summaries($1) AS refreshed_count",
      [250],
    );
  });

  it("rejects invalid drain batch sizes", async () => {
    process.argv = ["node", "run-activity-rollups.ts", "drain", "0"];

    await expect(main()).rejects.toThrow("Batch size must be an integer between 1 and 1000");

    expect(mockClientEnd).toHaveBeenCalled();
  });

  it("falls back to zero when a backfill query returns no row", async () => {
    process.argv = ["node", "run-activity-rollups.ts", "enqueue-backfill"];
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    await main();

    expect(stdoutWriteSpy).toHaveBeenCalledWith("queued=0\n");
  });

  it("reports direct-run failures to stderr and exits nonzero", async () => {
    delete process.env.DATABASE_URL;
    process.argv = ["node", "run-activity-rollups.ts", "drain"];
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    vi.resetModules();
    await import("./run-activity-rollups.ts");
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", recordUnhandledRejection);

    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.stringContaining("DATABASE_URL"));
    expect(processExitSpy).toHaveBeenCalledWith(1);
    expect(unhandledRejections).toHaveLength(1);
    expect(unhandledRejections[0]).toEqual(new Error("process.exit called"));
  });
});
