import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { backfillRecordLocalTimeContext } from "./record-local-time-context-backfill.ts";

const dialect = new PgDialect();
const timeWindow = {
  startAt: new Date("2026-01-01T00:00:00.000Z"),
  endAt: new Date("2027-01-01T00:00:00.000Z"),
};

describe("backfillRecordLocalTimeContext", () => {
  it("bounds candidates by time and persists the normalized timezone with independent offsets", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000001",
          timezone: "  America/Los_Angeles  ",
          local_time_source: "unknown",
          home_timezone: null,
          started_at: "2026-03-08T09:30:00.000Z",
          ended_at: "2026-03-08T10:30:00.000Z",
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([]);

    await expect(
      backfillRecordLocalTimeContext(
        { execute },
        { execute: true, batchSize: 10, maxBatches: 2, ...timeWindow },
      ),
    ).resolves.toEqual({ eligible: 1, skipped: 0, updated: 1 });

    expect(execute).toHaveBeenCalledTimes(3);
    const candidateQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(candidateQuery.sql).toContain("started_at >= ");
    expect(candidateQuery.sql).toContain("started_at < ");
    expect(candidateQuery.params).toEqual(
      expect.arrayContaining([timeWindow.startAt, timeWindow.endAt]),
    );

    const updateQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(updateQuery.sql).toContain("timezone = context_values.timezone");
    expect(updateQuery.sql).toContain(
      "activity.timezone IS NOT DISTINCT FROM context_values.prior_timezone",
    );
    expect(updateQuery.sql).toContain("activity.started_at = context_values.prior_started_at");
    expect(updateQuery.sql).toContain(
      "activity.ended_at IS NOT DISTINCT FROM context_values.prior_ended_at",
    );
    expect(updateQuery.params).toContain("America/Los_Angeles");
    expect(updateQuery.params).toContain("  America/Los_Angeles  ");
  });

  it("replaces an unreliable fixed provider zone with the persisted home zone", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000003",
          timezone: "Etc/GMT+4",
          local_time_source: "provider_timezone",
          home_timezone: "America/Los_Angeles",
          started_at: "2026-09-01T14:55:54.000Z",
          ended_at: "2026-09-01T15:25:54.000Z",
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([]);

    await expect(
      backfillRecordLocalTimeContext(
        { execute },
        { execute: true, batchSize: 10, maxBatches: 2, ...timeWindow },
      ),
    ).resolves.toEqual({ eligible: 1, skipped: 0, updated: 1 });

    const updateQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(updateQuery.params[1]).toBe("America/Los_Angeles");
    expect(updateQuery.params).toContain("user_home_timezone");
    expect(updateQuery.params).toContain("Etc/GMT+4");
  });

  it("is a bounded dry run and skips invalid stored timezones", async () => {
    const execute = vi.fn().mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000002",
        timezone: "Not/A_Timezone",
        local_time_source: "unknown",
        home_timezone: null,
        started_at: "2026-03-08T09:30:00.000Z",
        ended_at: null,
      },
    ]);

    await expect(
      backfillRecordLocalTimeContext(
        { execute },
        { execute: false, batchSize: 1, maxBatches: 1, ...timeWindow },
      ),
    ).resolves.toEqual({ eligible: 1, skipped: 1, updated: 0 });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not hide a malformed fixed provider timezone behind the home timezone", async () => {
    const execute = vi.fn().mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000004",
        timezone: "Etc/GMT+99",
        local_time_source: "provider_timezone",
        home_timezone: "America/Los_Angeles",
        started_at: "2026-03-08T09:30:00.000Z",
        ended_at: null,
      },
    ]);

    await expect(
      backfillRecordLocalTimeContext(
        { execute },
        { execute: true, batchSize: 10, maxBatches: 1, ...timeWindow },
      ),
    ).resolves.toEqual({ eligible: 1, skipped: 1, updated: 0 });

    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects unbounded or invalid batch options", async () => {
    const db = { execute: vi.fn() };

    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 0,
        maxBatches: 1,
        ...timeWindow,
      }),
    ).rejects.toThrow("batchSize");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 10,
        maxBatches: 0,
        ...timeWindow,
      }),
    ).rejects.toThrow("maxBatches");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 1_001,
        maxBatches: 1,
        ...timeWindow,
      }),
    ).rejects.toThrow("batchSize");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 1.5,
        maxBatches: 1,
        ...timeWindow,
      }),
    ).rejects.toThrow("batchSize");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 10,
        maxBatches: 1.5,
        ...timeWindow,
      }),
    ).rejects.toThrow("maxBatches");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 10,
        maxBatches: 1,
        startAt: new Date("invalid"),
        endAt: timeWindow.endAt,
      }),
    ).rejects.toThrow("startAt");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 10,
        maxBatches: 1,
        startAt: timeWindow.startAt,
        endAt: new Date("invalid"),
      }),
    ).rejects.toThrow("endAt");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 10,
        maxBatches: 1,
        startAt: timeWindow.endAt,
        endAt: timeWindow.startAt,
      }),
    ).rejects.toThrow("startAt must be earlier than endAt");
    await expect(
      backfillRecordLocalTimeContext(db, {
        execute: false,
        batchSize: 10,
        maxBatches: 1,
        startAt: timeWindow.startAt,
        endAt: timeWindow.startAt,
      }),
    ).rejects.toThrow("startAt must be earlier than endAt");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("accepts the maximum bounded batch size", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(
      backfillRecordLocalTimeContext(
        { execute },
        { execute: false, batchSize: 1_000, maxBatches: 1, ...timeWindow },
      ),
    ).resolves.toEqual({ eligible: 0, skipped: 0, updated: 0 });
  });

  it("paginates subsequent batches from the last activity id", async () => {
    const firstId = "00000000-0000-4000-8000-000000000010";
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: firstId,
          timezone: "America/Los_Angeles",
          local_time_source: "unknown",
          home_timezone: null,
          started_at: "2026-06-01T12:00:00.000Z",
          ended_at: null,
        },
      ])
      .mockResolvedValueOnce([]);

    await backfillRecordLocalTimeContext(
      { execute },
      { execute: false, batchSize: 1, maxBatches: 2, ...timeWindow },
    );

    const firstQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    const secondQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(firstQuery.sql).not.toContain("activity.id >");
    expect(secondQuery.sql).toContain("activity.id >");
    expect(secondQuery.params).toContain(firstId);
  });

  it("uses a trimmed home zone only for exact fixed Etc/GMT names", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000011",
          timezone: "Etc/GMT",
          local_time_source: "provider_timezone",
          home_timezone: "  America/Los_Angeles  ",
          started_at: "2026-06-01T12:00:00.000Z",
          ended_at: null,
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }]);
    await backfillRecordLocalTimeContext(
      { execute },
      { execute: true, batchSize: 1, maxBatches: 1, ...timeWindow },
    );
    const updateQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(updateQuery.params).toContain("America/Los_Angeles");
    expect(updateQuery.params).toContain("user_home_timezone");
  });

  it("preserves a named provider zone when a home zone is also available", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000013",
          timezone: "America/New_York",
          local_time_source: "provider_timezone",
          home_timezone: "America/Los_Angeles",
          started_at: "2026-06-01T12:00:00.000Z",
          ended_at: null,
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }]);

    await backfillRecordLocalTimeContext(
      { execute },
      { execute: true, batchSize: 1, maxBatches: 1, ...timeWindow },
    );

    const updateQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(updateQuery.params).toContain("America/New_York");
    expect(updateQuery.params).toContain("provider_timezone");
    expect(updateQuery.params).not.toContain("user_home_timezone");
  });

  it("preserves a fixed provider zone when no home zone is available", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000014",
          timezone: "Etc/GMT+4",
          local_time_source: "provider_timezone",
          home_timezone: null,
          started_at: "2026-06-01T12:00:00.000Z",
          ended_at: null,
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }]);

    await backfillRecordLocalTimeContext(
      { execute },
      { execute: true, batchSize: 1, maxBatches: 1, ...timeWindow },
    );

    const updateQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(updateQuery.params).toContain("Etc/GMT+4");
    expect(updateQuery.params).toContain("provider_timezone");
  });

  it("recognizes a whitespace-padded fixed provider zone", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000015",
          timezone: "  Etc/GMT+4  ",
          local_time_source: "provider_timezone",
          home_timezone: "America/Los_Angeles",
          started_at: "2026-06-01T12:00:00.000Z",
          ended_at: null,
        },
      ])
      .mockResolvedValueOnce([{ count: 1 }]);

    await backfillRecordLocalTimeContext(
      { execute },
      { execute: true, batchSize: 1, maxBatches: 1, ...timeWindow },
    );

    const updateQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(updateQuery.params).toContain("America/Los_Angeles");
    expect(updateQuery.params).toContain("user_home_timezone");
  });

  it.each(["prefixEtc/GMT+4", "Etc/GMT+4suffix"])(
    "rejects malformed fixed-zone lookalike %s",
    async (timezone) => {
      const execute = vi.fn().mockResolvedValueOnce([
        {
          id: "00000000-0000-4000-8000-000000000012",
          timezone,
          local_time_source: "provider_timezone",
          home_timezone: "America/Los_Angeles",
          started_at: "2026-06-01T12:00:00.000Z",
          ended_at: null,
        },
      ]);
      await expect(
        backfillRecordLocalTimeContext(
          { execute },
          { execute: false, batchSize: 1, maxBatches: 1, ...timeWindow },
        ),
      ).resolves.toEqual({ eligible: 1, skipped: 1, updated: 0 });
    },
  );
});
