import { WhoopClient } from "@dofek/whoop/client";
import type { WhoopCycle } from "@dofek/whoop/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import { dailyMetrics } from "../../db/schema/activity.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { syncWhoopRecovery } from "./sync-recovery.ts";
import { syncWhoopSleepSessions, syncWhoopSleepStagesForId } from "./sync-sleep.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

const tokenUserContextMocks = vi.hoisted(() => ({
  getTokenUserId: vi.fn((): string | undefined => "00000000-0000-0000-0000-000000000001"),
}));

vi.mock("../../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      callback: () => Promise<{ recordCount: number; result: number }>,
    ) => {
      const result = await callback();
      return result.result;
    },
  ),
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: tokenUserContextMocks.getTokenUserId,
}));

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

  return { db, chain, insert: db.insert, select: db.select };
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
    windowEnd: new Date("2026-05-02T00:00:00.000Z"),
    options: { userId: "user-1" },
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-09T00:00:00.000Z"));
  tokenUserContextMocks.getTokenUserId.mockClear();
  tokenUserContextMocks.getTokenUserId.mockReturnValue("00000000-0000-0000-0000-000000000001");
  vi.mocked(withSyncLog).mockImplementation(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      callback: () => Promise<{ recordCount: number; result: unknown }>,
    ) => {
      const result = await callback();
      return result.result;
    },
  );
});

function makeWhoopSleepRecord(
  overrides: Partial<{
    id: number;
    stages: Array<{ stage: string; during: string }> | undefined;
  }> = {},
) {
  return {
    id: 123,
    user_id: 123,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    timezone_offset: "Z",
    nap: false,
    stages: [{ stage: "slow_wave", during: "['2026-05-01T04:00:00Z','2026-05-01T05:00:00Z')" }],
    ...overrides,
  };
}

describe("WHOOP sync helpers", () => {
  it("uses the WHOOP sleep id as externalId for main inline sleeps", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        sleep: { id: 12345 },
        recovery: {
          sleep_id: 12345,
          user_id: 123,
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
        },
        sleeps: [
          {
            during: "['2026-05-01T04:00:00Z','2026-05-01T12:00:00Z')",
            state: "complete",
            time_in_bed: 28_800_000,
            wake_duration: 1_800_000,
            light_sleep_duration: 12_000_000,
            slow_wave_sleep_duration: 6_000_000,
            rem_sleep_duration: 7_200_000,
          },
        ],
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopSleepSessions(context)).resolves.toBe(1);
    expect(db.chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "12345",
      }),
    );
  });

  it("syncs complete inline sleep sessions and skips invalid or incomplete rows", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        sleeps: [
          {
            during: "['2026-05-01T04:00:00Z','2026-05-01T12:00:00Z')",
            state: "complete",
            time_in_bed: 28_800_000,
            wake_duration: 1_800_000,
            light_sleep_duration: 12_000_000,
            slow_wave_sleep_duration: 6_000_000,
            rem_sleep_duration: 7_200_000,
            in_sleep_efficiency: 0.875,
          },
          {
            during: "['2026-05-02T04:00:00Z','2026-05-02T05:00:00Z')",
            state: "pending",
            time_in_bed: 3_600_000,
            wake_duration: 0,
            light_sleep_duration: 3_600_000,
            slow_wave_sleep_duration: 0,
            rem_sleep_duration: 0,
          },
          { during: "bad" },
        ],
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopSleepSessions(context)).resolves.toBe(1);
    expect(db.chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "whoop",
        externalId: "inline-2026-05-01T04:00:00.000Z-0",
        durationMinutes: 450,
        efficiencyPct: 87.5,
      }),
    );
  });

  it("persists respiratory rate from a completed main sleep on the WHOOP recovery day", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        days: ["2026-05-01"],
        recovery: {
          user_id: 123,
          created_at: "2026-05-02T14:00:00.000Z",
          updated_at: "2026-05-02T14:00:00.000Z",
        },
        sleeps: [
          {
            during: "['2026-05-02T06:00:00Z','2026-05-02T14:00:00Z')",
            state: "complete",
            time_in_bed: 28_800_000,
            wake_duration: 1_800_000,
            light_sleep_duration: 12_000_000,
            slow_wave_sleep_duration: 6_000_000,
            rem_sleep_duration: 7_200_000,
            respiratory_rate: 13.5,
          },
        ],
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopSleepSessions(context)).resolves.toBe(1);

    expect(db.insert).toHaveBeenCalledWith(dailyMetrics);
    expect(db.chain.values).toHaveBeenCalledWith({
      date: "2026-05-01",
      providerId: "whoop",
      respiratoryRateAvg: 13.5,
    });
  });

  it("falls back to the sleep end day when cycle and recovery dates are invalid", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        days: ["not-a-date"],
        recovery: {
          user_id: 123,
          created_at: "also-not-a-date",
          updated_at: "2026-05-02T14:00:00.000Z",
        },
        sleeps: [
          {
            during: "['2026-05-02T06:00:00Z','2026-05-02T14:00:00Z')",
            state: "complete",
            time_in_bed: 28_800_000,
            wake_duration: 1_800_000,
            light_sleep_duration: 12_000_000,
            slow_wave_sleep_duration: 6_000_000,
            rem_sleep_duration: 7_200_000,
            respiratory_rate: 13.5,
          },
        ],
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopSleepSessions(context)).resolves.toBe(1);

    expect(db.chain.values).toHaveBeenCalledWith({
      date: "2026-05-02",
      providerId: "whoop",
      respiratoryRateAvg: 13.5,
    });
  });

  it("falls back to the recovery day when canonical cycle dates are invalid", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        days: ["not-a-date"],
        recovery: {
          cycle_id: 1,
          user_id: 123,
          created_at: "2026-05-02T14:00:00.000Z",
          updated_at: "2026-05-02T14:00:00.000Z",
          resting_heart_rate: 52,
          hrv_rmssd: 0.06,
        },
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopRecovery(context)).resolves.toBe(1);

    expect(db.chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-05-02",
        providerId: "whoop",
        hrv: 60,
      }),
    );
  });

  it("uses the first valid canonical cycle date before the recovery timestamp", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        days: ["not-a-date", "2026-05-01"],
        recovery: {
          cycle_id: 1,
          user_id: 123,
          created_at: "2026-05-02T14:00:00.000Z",
          updated_at: "2026-05-02T14:00:00.000Z",
          resting_heart_rate: 52,
          hrv_rmssd: 0.06,
        },
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopRecovery(context)).resolves.toBe(1);

    expect(db.chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-05-01",
        providerId: "whoop",
      }),
    );
  });

  it("syncWhoopSleepStagesForId returns 0 without persisting unmapped stage rows", async () => {
    const db = makeDb([{ id: "session-1" }]);
    const client = makeClient();
    vi.spyOn(client, "getSleep").mockResolvedValue(
      makeWhoopSleepRecord({
        stages: [{ stage: "unknown", during: "['2026-05-01T04:00:00Z','2026-05-01T05:00:00Z')" }],
      }),
    );
    const context = makeContext({ db: db.db, client });

    await expect(syncWhoopSleepStagesForId(context, "123")).resolves.toBe(0);
    expect(db.chain.values).not.toHaveBeenCalled();
  });

  it("syncWhoopSleepStagesForId returns 0 when the API record has no stage rows", async () => {
    const db = makeDb([{ id: "session-1" }]);
    const client = makeClient();
    vi.spyOn(client, "getSleep").mockResolvedValue(makeWhoopSleepRecord({ stages: undefined }));
    const context = makeContext({ db: db.db, client });

    await expect(syncWhoopSleepStagesForId(context, "123")).resolves.toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("syncWhoopSleepStagesForId returns 0 when no local session matches the sleep id", async () => {
    const db = makeDb([]);
    const client = makeClient();
    vi.spyOn(client, "getSleep").mockResolvedValue(makeWhoopSleepRecord());
    const context = makeContext({ db: db.db, client });

    await expect(syncWhoopSleepStagesForId(context, "123")).resolves.toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
