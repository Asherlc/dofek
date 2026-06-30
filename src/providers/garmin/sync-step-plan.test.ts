import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import { dailyMetrics, sleepSession } from "../../db/schema/activity.ts";
import { syncApiQueryKey } from "../../lib/sync-api-query.ts";
import {
  type GarminSyncPlanContext,
  listGarminDatesNeedingDailySummarySteps,
  listGarminDatesNeedingHrvSteps,
  listGarminDatesNeedingSleepSteps,
  planGarminSyncSteps,
} from "./sync-step-plan.ts";

const tokenUserContextMocks = vi.hoisted(() => ({
  getTokenUserId: vi.fn((): string | undefined => "00000000-0000-0000-0000-000000000001"),
}));

const clickHouseMocks = vi.hoisted(() => {
  const query = vi.fn();
  const close = vi.fn();
  return {
    query,
    close,
    createClickHouseClientFromEnv: vi.fn(() => ({ query, close })),
  };
});

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: tokenUserContextMocks.getTokenUserId,
}));

vi.mock("../../db/clickhouse.ts", () => ({
  createClickHouseClientFromEnv: clickHouseMocks.createClickHouseClientFromEnv,
}));

vi.mock("@sentry/node", () => ({
  captureException: sentryMocks.captureException,
}));

const pendingQueryMocks = vi.hoisted(() => ({
  listPendingSyncRequestQueryKeys: vi.fn(async () => new Set<string>()),
}));

vi.mock("../../lib/sync-request-queue.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sync-request-queue.ts")>();
  return {
    ...actual,
    listPendingSyncRequestQueryKeys: pendingQueryMocks.listPendingSyncRequestQueryKeys,
  };
});

function makeDb(selectedRows: unknown[] = []) {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };

  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockResolvedValue(undefined);
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(
    Object.assign(Promise.resolve(selectedRows), {
      limit: vi.fn().mockResolvedValue(selectedRows),
    }),
  );
  chain.limit.mockResolvedValue(selectedRows);

  const db: SyncDatabase = {
    insert: vi.fn().mockReturnValue(chain),
    select: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    execute: vi.fn().mockResolvedValue([]),
  };

  return { db, chain, select: db.select };
}

function makeContext(overrides: Partial<GarminSyncPlanContext> = {}): GarminSyncPlanContext {
  const { db } = makeDb();
  return {
    db,
    providerId: "garmin",
    sinceDate: "2026-03-01",
    untilDate: "2026-03-02",
    dates: ["2026-03-01", "2026-03-02"],
    userId: "options-user",
    ...overrides,
  };
}

beforeEach(() => {
  tokenUserContextMocks.getTokenUserId.mockClear();
  tokenUserContextMocks.getTokenUserId.mockReturnValue("00000000-0000-0000-0000-000000000001");
  clickHouseMocks.createClickHouseClientFromEnv.mockClear();
  clickHouseMocks.query.mockReset();
  clickHouseMocks.query.mockResolvedValue({ json: async () => [] });
  clickHouseMocks.close.mockClear();
  sentryMocks.captureException.mockClear();
  pendingQueryMocks.listPendingSyncRequestQueryKeys.mockReset();
  pendingQueryMocks.listPendingSyncRequestQueryKeys.mockResolvedValue(new Set());
  delete process.env.CLICKHOUSE_URL;
});

describe("Garmin sync step planning", () => {
  it("plans one HTTP step per data call in phase order when nothing is synced", async () => {
    const context = makeContext();

    await expect(planGarminSyncSteps(context)).resolves.toEqual([
      { type: "activities_list", offset: 0 },
      { type: "sleep", date: "2026-03-01" },
      { type: "daily_summary", date: "2026-03-01" },
      { type: "hrv_summary", date: "2026-03-01" },
      { type: "stress", date: "2026-03-01" },
      { type: "heart_rate", date: "2026-03-01" },
      { type: "sleep", date: "2026-03-02" },
      { type: "daily_summary", date: "2026-03-02" },
      { type: "hrv_summary", date: "2026-03-02" },
      { type: "stress", date: "2026-03-02" },
      { type: "heart_rate", date: "2026-03-02" },
    ]);
  });

  it("lists only daily summary dates that are not already synced for the resolved user", async () => {
    const db = makeDb([{ date: "2026-03-01" }]);
    const context = makeContext({ db: db.db, userId: "options-user" });

    await expect(listGarminDatesNeedingDailySummarySteps(context)).resolves.toEqual(["2026-03-02"]);
    expect(tokenUserContextMocks.getTokenUserId).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledWith({ date: dailyMetrics.date });
  });

  it("lists only HRV dates that are not already synced for the resolved user", async () => {
    const db = makeDb([{ date: "2026-03-02" }]);
    const context = makeContext({ db: db.db, userId: "options-user" });

    await expect(listGarminDatesNeedingHrvSteps(context)).resolves.toEqual(["2026-03-01"]);
    expect(db.select).toHaveBeenCalledWith({ date: dailyMetrics.date });
  });

  it("falls back to the token user id when sync options omit userId", async () => {
    tokenUserContextMocks.getTokenUserId.mockReturnValue("token-user");
    const db = makeDb([{ date: "2026-03-02" }]);
    const context = makeContext({ db: db.db, userId: undefined });

    await expect(listGarminDatesNeedingDailySummarySteps(context)).resolves.toEqual(["2026-03-01"]);
    expect(tokenUserContextMocks.getTokenUserId).toHaveBeenCalled();
  });

  it("does not skip dates when no user id can be resolved", async () => {
    tokenUserContextMocks.getTokenUserId.mockReturnValue(undefined);
    const db = makeDb([{ date: "2026-03-01" }]);
    const context = makeContext({ db: db.db, userId: undefined });

    await expect(listGarminDatesNeedingDailySummarySteps(context)).resolves.toEqual([
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("does not skip sleep or HRV dates when no user id can be resolved", async () => {
    tokenUserContextMocks.getTokenUserId.mockReturnValue(undefined);
    const db = makeDb([
      {
        date: "2026-03-01",
        startedAt: new Date("2026-03-01T23:00:00.000Z"),
        endedAt: new Date("2026-03-02T07:00:00.000Z"),
      },
    ]);
    const context = makeContext({ db: db.db, userId: undefined });

    await expect(listGarminDatesNeedingSleepSteps(context)).resolves.toEqual([
      "2026-03-01",
      "2026-03-02",
    ]);
    await expect(listGarminDatesNeedingHrvSteps(context)).resolves.toEqual([
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("lists only sleep dates that do not already have a session on that UTC day", async () => {
    const db = makeDb([
      {
        startedAt: new Date("2026-03-01T23:00:00.000Z"),
        endedAt: new Date("2026-03-02T07:00:00.000Z"),
      },
    ]);
    const context = makeContext({ db: db.db, userId: "options-user" });

    await expect(listGarminDatesNeedingSleepSteps(context)).resolves.toEqual([]);
    expect(db.select).toHaveBeenCalledWith({
      startedAt: sleepSession.startedAt,
      endedAt: sleepSession.endedAt,
    });
  });

  it("ignores sleep session endpoints outside the sync date range", async () => {
    const db = makeDb([
      {
        startedAt: new Date("2026-02-28T23:00:00.000Z"),
        endedAt: new Date("2026-03-03T07:00:00.000Z"),
      },
    ]);
    const context = makeContext({
      db: db.db,
      dates: ["2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03"],
      userId: "options-user",
    });

    await expect(listGarminDatesNeedingSleepSteps(context)).resolves.toEqual([
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ]);
  });

  it("does not use ClickHouse metric-stream skips when CLICKHOUSE_URL is absent", async () => {
    clickHouseMocks.query.mockImplementation(async () => ({
      json: async () => [{ date: "2026-03-01" }, { date: "2026-03-02" }],
    }));
    const context = makeContext();

    await expect(planGarminSyncSteps(context)).resolves.toEqual(
      expect.arrayContaining([
        { type: "stress", date: "2026-03-01" },
        { type: "heart_rate", date: "2026-03-01" },
        { type: "stress", date: "2026-03-02" },
        { type: "heart_rate", date: "2026-03-02" },
      ]),
    );
    expect(clickHouseMocks.createClickHouseClientFromEnv).not.toHaveBeenCalled();
  });

  it("does not use ClickHouse metric-stream skips when no user id can be resolved", async () => {
    process.env.CLICKHOUSE_URL = "http://default:health@127.0.0.1:8123";
    tokenUserContextMocks.getTokenUserId.mockReturnValue(undefined);
    clickHouseMocks.query.mockResolvedValue({
      json: async () => [{ date: "2026-03-01" }, { date: "2026-03-02" }],
    });
    const context = makeContext({ userId: undefined });

    await expect(planGarminSyncSteps(context)).resolves.toEqual(
      expect.arrayContaining([
        { type: "stress", date: "2026-03-01" },
        { type: "heart_rate", date: "2026-03-01" },
        { type: "stress", date: "2026-03-02" },
        { type: "heart_rate", date: "2026-03-02" },
      ]),
    );
    expect(clickHouseMocks.createClickHouseClientFromEnv).not.toHaveBeenCalled();
  });

  it("skips stress steps already present in ClickHouse", async () => {
    process.env.CLICKHOUSE_URL = "http://default:health@127.0.0.1:8123";
    const db = makeDb([
      {
        date: "2026-03-01",
        startedAt: new Date("2026-03-01T23:00:00.000Z"),
        endedAt: new Date("2026-03-02T07:00:00.000Z"),
      },
    ]);
    clickHouseMocks.query.mockImplementation(
      async (args: { query_params?: { channel?: string } }) => ({
        json: async () =>
          args.query_params?.channel === "stress"
            ? [{ date: "2026-03-01" }, { date: "2026-03-02" }]
            : [],
      }),
    );
    const context = makeContext({ db: db.db, userId: "options-user" });

    await expect(planGarminSyncSteps(context)).resolves.toEqual([
      { type: "activities_list", offset: 0 },
      { type: "heart_rate", date: "2026-03-01" },
      { type: "daily_summary", date: "2026-03-02" },
      { type: "hrv_summary", date: "2026-03-02" },
      { type: "heart_rate", date: "2026-03-02" },
    ]);
    expect(clickHouseMocks.query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query_params: {
          userId: "options-user",
          providerId: "garmin",
          channel: "stress",
          rangeStart: "2026-03-01T00:00:00.000Z",
          rangeEnd: "2026-03-03T00:00:00.000Z",
        },
      }),
    );
    expect(clickHouseMocks.close).toHaveBeenCalledTimes(2);
  });

  it("closes ClickHouse clients and surfaces metric-stream query failures", async () => {
    process.env.CLICKHOUSE_URL = "http://default:health@127.0.0.1:8123";
    const queryError = new Error("connection refused");
    clickHouseMocks.query.mockRejectedValue(queryError);
    const context = makeContext();

    await expect(planGarminSyncSteps(context)).rejects.toThrow("connection refused");
    expect(clickHouseMocks.close).toHaveBeenCalled();
    expect(sentryMocks.captureException).toHaveBeenCalledWith(queryError, {
      tags: { provider: "garmin", operation: "metric_stream_date_query" },
      extra: { channel: "stress", providerId: "garmin" },
    });
  });

  it("omits API steps already represented on queued request jobs", async () => {
    pendingQueryMocks.listPendingSyncRequestQueryKeys.mockResolvedValue(
      new Set([
        syncApiQueryKey({
          path: "connectapi/heart-rate",
          filters: { date: "2026-03-01" },
        }),
      ]),
    );

    const steps = await planGarminSyncSteps(makeContext());

    expect(steps.some((step) => step.type === "heart_rate" && step.date === "2026-03-01")).toBe(
      false,
    );
    expect(steps.some((step) => step.type === "heart_rate" && step.date === "2026-03-02")).toBe(
      true,
    );
  });
});
