import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { backfillRecordLocalTimeContext } from "../src/db/record-local-time-context-backfill.ts";
import { main } from "./backfill-record-local-time-context.ts";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
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
  it("defaults to a bounded dry run", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const db = { execute: vi.fn(), $client: { end } };
    vi.mocked(createDatabaseFromEnv).mockReturnValue(db);
    vi.mocked(backfillRecordLocalTimeContext).mockResolvedValue({
      eligible: 3,
      skipped: 1,
      updated: 0,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([]);

    expect(backfillRecordLocalTimeContext).toHaveBeenCalledWith(db, {
      execute: false,
      batchSize: 250,
      maxBatches: 20,
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

    await main(["--execute", "--batch-size=20", "--max-batches=4"]);

    expect(backfillRecordLocalTimeContext).toHaveBeenCalledWith(db, {
      execute: true,
      batchSize: 20,
      maxBatches: 4,
    });
  });

  it("rejects invalid bounds before opening the database", async () => {
    await expect(main(["--batch-size=0"])).rejects.toThrow("--batch-size");
    expect(createDatabaseFromEnv).not.toHaveBeenCalled();
  });
});
