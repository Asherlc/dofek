import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { backfillRecordLocalTimeContext } from "../src/db/record-local-time-context-backfill.ts";
import { main } from "./backfill-record-local-time-context.ts";

vi.mock("../src/lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  close: vi.fn(async () => true),
  init: vi.fn(),
}));
vi.mock("../src/db/record-local-time-context-backfill.ts", () => ({
  backfillRecordLocalTimeContext: vi.fn(),
}));
vi.mock("../src/db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("main", () => {
  it("defaults to a bounded dry run within an explicit time window", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const db = { execute: vi.fn(), $client: { end } };
    vi.mocked(createDatabaseFromEnv).mockReturnValue(db);
    vi.mocked(backfillRecordLocalTimeContext).mockResolvedValue({
      eligible: 3,
      skipped: 1,
      updated: 0,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--start-at=2026-01-01T00:00:00.000Z", "--end-at=2026-02-01T00:00:00.000Z"]);

    expect(backfillRecordLocalTimeContext).toHaveBeenCalledWith(db, {
      execute: false,
      batchSize: 250,
      maxBatches: 20,
      startAt: new Date("2026-01-01T00:00:00.000Z"),
      endAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(end).toHaveBeenCalledOnce();
    expect(Sentry.close).toHaveBeenCalledWith(2_000);
  });

  it("accepts explicit execution bounds", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const db = { execute: vi.fn(), $client: { end } };
    vi.mocked(createDatabaseFromEnv).mockReturnValue(db);
    vi.mocked(backfillRecordLocalTimeContext).mockResolvedValue({
      eligible: 2,
      skipped: 0,
      updated: 2,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([
      "--execute",
      "--batch-size=20",
      "--max-batches=4",
      "--start-at=2025-01-01T00:00:00.000Z",
      "--end-at=2026-01-01T00:00:00.000Z",
    ]);

    expect(backfillRecordLocalTimeContext).toHaveBeenCalledWith(db, {
      execute: true,
      batchSize: 20,
      maxBatches: 4,
      startAt: new Date("2025-01-01T00:00:00.000Z"),
      endAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("rejects invalid bounds before opening the database", async () => {
    await expect(
      main([
        "--batch-size=0",
        "--start-at=2025-01-01T00:00:00.000Z",
        "--end-at=2026-01-01T00:00:00.000Z",
      ]),
    ).rejects.toThrow("--batch-size");
    await expect(main([])).rejects.toThrow("--start-at");
    await expect(main(["--start-at=invalid", "--end-at=2026-01-01T00:00:00.000Z"])).rejects.toThrow(
      "--start-at",
    );
    await expect(
      main(["--start-at=2026-02-01T00:00:00.000Z", "--end-at=2026-01-01T00:00:00.000Z"]),
    ).rejects.toThrow("--start-at must be earlier than --end-at");
    expect(createDatabaseFromEnv).not.toHaveBeenCalled();
  });
});
