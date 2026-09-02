import { WhoopClient } from "@dofek/whoop/client";
import type { WhoopCycle, WhoopWorkoutRecord } from "@dofek/whoop/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import { dailyMetrics, sleepSession } from "../../db/schema/activity.ts";
import { syncApiQueryKey } from "../../lib/sync-api-query.ts";
import {
  iterateUtcDates,
  listWhoopHeartRateWindows,
  listWhoopSleepIdsNeedingStages,
  listWhoopStepDatesNeedingSteps,
  planWhoopApiSteps,
} from "./sync-step-plan.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

const tokenUserContextMocks = vi.hoisted(() => ({
  getTokenUserId: vi.fn((): string | undefined => "00000000-0000-0000-0000-000000000001"),
}));

const pendingQueryMocks = vi.hoisted(() => ({
  listPendingSyncRequestQueryKeys: vi.fn(async () => new Set<string>()),
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: tokenUserContextMocks.getTokenUserId,
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

function makeWorkoutRecord(
  overrides: Partial<{ activity_id: string | undefined }> = {},
): WhoopWorkoutRecord {
  return {
    activity_id: "workout-1",
    during: "['2026-05-01T10:00:00Z','2026-05-01T11:00:00Z')",
    sport_id: 0,
    average_heart_rate: 155,
    max_heart_rate: 185,
    kilojoules: 2500.5,
    score: 12.5,
    timezone_offset: "Z",
    ...overrides,
  };
}

function makeClient() {
  return new WhoopClient({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    userId: 123,
    expiresInSeconds: 3600,
  });
}

function makeContext(overrides: Partial<WhoopSyncContext> = {}): WhoopSyncContext {
  const { db } = makeDb();
  return {
    db,
    client: makeClient(),
    cycles: [],
    providerId: "whoop",
    since: new Date("2026-05-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-03T00:00:00.000Z"),
    options: { userId: "user-1" },
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  tokenUserContextMocks.getTokenUserId.mockClear();
  tokenUserContextMocks.getTokenUserId.mockReturnValue("00000000-0000-0000-0000-000000000001");
  pendingQueryMocks.listPendingSyncRequestQueryKeys.mockReset();
  pendingQueryMocks.listPendingSyncRequestQueryKeys.mockResolvedValue(new Set());
});

describe("WHOOP sync step planning", () => {
  it("iterates UTC dates inclusively through the window end day", () => {
    expect([
      ...iterateUtcDates(
        new Date("2026-05-01T15:00:00.000Z"),
        Date.parse("2026-05-03T12:00:00.000Z"),
      ),
    ]).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
  });

  it("splits heart rate sync windows into one-week chunks capped at the window end", () => {
    const since = new Date("2026-05-01T00:00:00.000Z");
    const untilMs = Date.parse("2026-05-11T00:00:00.000Z");

    expect(listWhoopHeartRateWindows(since, untilMs)).toEqual([
      {
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-08T00:00:00.000Z",
      },
      {
        start: "2026-05-08T00:00:00.000Z",
        end: "2026-05-11T00:00:00.000Z",
      },
    ]);
  });

  it("lists only step dates that are not already synced for the resolved user", async () => {
    const db = makeDb([{ date: "2026-05-01" }]);
    const context = makeContext({ db: db.db, options: { userId: "options-user" } });

    await expect(listWhoopStepDatesNeedingSteps(context)).resolves.toEqual([
      "2026-05-02",
      "2026-05-03",
    ]);
    expect(tokenUserContextMocks.getTokenUserId).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledWith({ date: dailyMetrics.date });
  });

  it("falls back to the token user id when sync options omit userId", async () => {
    tokenUserContextMocks.getTokenUserId.mockReturnValue("token-user");
    const db = makeDb([{ date: "2026-05-02" }]);
    const context = makeContext({ db: db.db, options: undefined });

    await expect(listWhoopStepDatesNeedingSteps(context)).resolves.toEqual([
      "2026-05-01",
      "2026-05-03",
    ]);
    expect(tokenUserContextMocks.getTokenUserId).toHaveBeenCalled();
  });

  it("does not skip step dates when no user id can be resolved", async () => {
    tokenUserContextMocks.getTokenUserId.mockReturnValue(undefined);
    const db = makeDb([{ date: "2026-05-01" }, { date: "2026-05-02" }]);
    const context = makeContext({ db: db.db, options: undefined });

    await expect(listWhoopStepDatesNeedingSteps(context)).resolves.toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
  });

  it("returns no sleep ids when cycles contain no sleep records", async () => {
    const db = makeDb([]);
    const context = makeContext({ db: db.db, cycles: [{ workouts: [makeWorkoutRecord()] }] });

    await expect(listWhoopSleepIdsNeedingStages(context)).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("lists only sleep ids that still need stage rows synced", async () => {
    const db = makeDb([{ externalId: "123" }]);
    const context = makeContext({
      db: db.db,
      options: { userId: "options-user" },
      cycles: [{ sleep: { id: 123 } }, { sleep: { id: 456 } }],
    });

    await expect(listWhoopSleepIdsNeedingStages(context)).resolves.toEqual(["456"]);
    expect(tokenUserContextMocks.getTokenUserId).not.toHaveBeenCalled();
    expect(db.select).toHaveBeenCalledWith({ externalId: sleepSession.externalId });
  });

  it("does not skip sleep stage steps when no user id can be resolved", async () => {
    tokenUserContextMocks.getTokenUserId.mockReturnValue(undefined);
    const db = makeDb([{ externalId: "123" }]);
    const context = makeContext({
      db: db.db,
      options: undefined,
      cycles: [{ sleep: { id: 123 } }],
    });

    await expect(listWhoopSleepIdsNeedingStages(context)).resolves.toEqual(["123"]);
  });

  it("collects workouts from strain.workouts when cycle.workouts is missing", async () => {
    const context = makeContext({
      cycles: [{ strain: { workouts: [makeWorkoutRecord({ activity_id: "strain-only" })] } }],
    });

    const steps = await planWhoopApiSteps(context);

    expect(steps).toContainEqual({ type: "weightlifting", activityId: "strain-only" });
  });

  it("plans core API steps plus weightlifting steps from strain.workouts fallback", async () => {
    const db = makeDb([]);
    const context = makeContext({
      db: db.db,
      cycles: [
        {
          sleep: { id: 123 },
          strain: { workouts: [makeWorkoutRecord({ activity_id: "strength-1" })] },
        } satisfies WhoopCycle,
      ],
    });

    const steps = await planWhoopApiSteps(context);

    expect(steps).toEqual([
      { type: "strain_deep_dive", date: "2026-05-01" },
      { type: "strain_deep_dive", date: "2026-05-02" },
      { type: "strain_deep_dive", date: "2026-05-03" },
      { type: "developer_workouts" },
      { type: "persist_workouts" },
      { type: "weightlifting", activityId: "strength-1" },
      { type: "sleep_stages", sleepId: "123" },
      { type: "heart_rate", start: "2026-05-01T00:00:00.000Z", end: "2026-05-03T00:00:00.000Z" },
      { type: "journal" },
    ]);
  });

  it("omits workouts without resolvable activity ids from the step plan", async () => {
    const context = makeContext({
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: undefined })] }],
    });

    const steps = await planWhoopApiSteps(context);

    expect(steps.filter((step) => step.type === "weightlifting")).toEqual([]);
  });

  it("omits API steps already represented on queued request jobs", async () => {
    pendingQueryMocks.listPendingSyncRequestQueryKeys.mockResolvedValue(
      new Set([
        syncApiQueryKey({
          path: "metrics-service/v1/metrics",
          filters: {
            end: "2026-05-03T00:00:00.000Z",
            name: "heart_rate",
            start: "2026-05-01T00:00:00.000Z",
            step: 6,
          },
        }),
      ]),
    );

    const steps = await planWhoopApiSteps(makeContext());

    expect(steps.some((step) => step.type === "heart_rate")).toBe(false);
    expect(steps.some((step) => step.type === "journal")).toBe(true);
  });
});
