import { describe, expect, it, vi } from "vitest";
import { backfillRecordLocalTimeContext } from "./record-local-time-context-backfill.ts";

describe("backfillRecordLocalTimeContext", () => {
  it("computes independent DST offsets and updates eligible activity rows", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000001",
          timezone: "America/Los_Angeles",
          started_at: "2026-03-08T09:30:00.000Z",
          ended_at: "2026-03-08T10:30:00.000Z",
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([]);

    await expect(
      backfillRecordLocalTimeContext({ execute }, { execute: true, batchSize: 10, maxBatches: 2 }),
    ).resolves.toEqual({ eligible: 1, skipped: 0, updated: 1 });

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("is a bounded dry run and skips invalid stored timezones", async () => {
    const execute = vi.fn().mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000002",
        timezone: "Not/A_Timezone",
        started_at: "2026-03-08T09:30:00.000Z",
        ended_at: null,
      },
    ]);

    await expect(
      backfillRecordLocalTimeContext({ execute }, { execute: false, batchSize: 1, maxBatches: 1 }),
    ).resolves.toEqual({ eligible: 1, skipped: 1, updated: 0 });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects unbounded or invalid batch options", async () => {
    const db = { execute: vi.fn() };

    await expect(
      backfillRecordLocalTimeContext(db, { execute: false, batchSize: 0, maxBatches: 1 }),
    ).rejects.toThrow("batchSize");
    await expect(
      backfillRecordLocalTimeContext(db, { execute: false, batchSize: 10, maxBatches: 0 }),
    ).rejects.toThrow("maxBatches");
    await expect(
      backfillRecordLocalTimeContext(db, { execute: false, batchSize: 1_001, maxBatches: 1 }),
    ).rejects.toThrow("batchSize");
    await expect(
      backfillRecordLocalTimeContext(db, { execute: false, batchSize: 1.5, maxBatches: 1 }),
    ).rejects.toThrow("batchSize");
    await expect(
      backfillRecordLocalTimeContext(db, { execute: false, batchSize: 10, maxBatches: 1.5 }),
    ).rejects.toThrow("maxBatches");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("accepts the maximum bounded batch size", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(
      backfillRecordLocalTimeContext(
        { execute },
        { execute: false, batchSize: 1_000, maxBatches: 1 },
      ),
    ).resolves.toEqual({ eligible: 0, skipped: 0, updated: 0 });
  });
});
