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

describe("run-activity-rollups main()", () => {
  const originalArguments = process.argv;
  const originalUrl = process.env.DATABASE_URL;
  const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  beforeEach(() => {
    process.argv = ["node", "run-activity-rollups.ts", "drain"];
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockClientConnect.mockClear();
    mockClientEnd.mockClear();
    mockClientQuery.mockClear();
    mockClientConstructor.mockClear();
    stdoutWriteSpy.mockClear();
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
});
