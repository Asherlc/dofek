import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { ensureProvider } from "../db/tokens.ts";
import { AutoSupplementsProvider } from "./auto-supplements.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "auto-supplements"),
}));

const USER_ID = "00000000-0000-0000-0000-000000000001";
const DEFINITION_ID = "00000000-0000-0000-0000-000000000101";
const SCHEDULE_ID = "00000000-0000-0000-0000-000000000201";

function mockDatabase(results: unknown[][]): SyncDatabase {
  const { db, spies } = createMockDatabase();
  spies.execute.mockImplementation(async () => results.shift() ?? []);
  return db;
}

describe("AutoSupplementsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("is always valid because it has no external configuration", () => {
    expect(new AutoSupplementsProvider().validate()).toBeNull();
  });

  it("requires the per-user sync identity before querying", async () => {
    const database = mockDatabase([]);
    const provider = new AutoSupplementsProvider();

    await expect(
      provider.sync(
        new SyncRun({
          db: database,
          window: SyncWindow.fromDateRange({
            sinceDate: "2026-07-20",
            untilDate: "2026-07-20",
          }),
        }),
      ),
    ).rejects.toThrow("auto-supplements sync requires userId");
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("materializes only the requested user's bounded definition dates", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00.000Z") });
    const database = mockDatabase([
      [{ value: "UTC" }],
      [
        {
          id: DEFINITION_ID,
          schedule_id: SCHEDULE_ID,
          effective_from: "2026-07-20",
          effective_to: null,
        },
      ],
      [{ id: "planned-event" }],
      [],
    ]);
    const provider = new AutoSupplementsProvider();

    const result = await provider.sync(
      new SyncRun({
        db: database,
        userId: USER_ID,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-07-20",
          untilDate: "2026-07-20",
        }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(vi.mocked(ensureProvider)).toHaveBeenCalledWith(
      database,
      "auto-supplements",
      "Auto-Supplements",
      undefined,
      USER_ID,
    );
    expect(JSON.stringify(vi.mocked(database.execute).mock.calls)).toContain(USER_ID);
    expect(JSON.stringify(vi.mocked(database.execute).mock.calls)).toContain(
      "fitness.supplement_dose_event",
    );
  });

  it("uses UTC when no stored timezone exists", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-20T12:00:00.000Z") });
    const database = mockDatabase([[], []]);

    const result = await new AutoSupplementsProvider().sync(
      new SyncRun({
        db: database,
        userId: USER_ID,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-07-20",
          untilDate: "2026-07-20",
        }),
      }),
    );

    expect(result).toEqual({
      provider: "auto-supplements",
      recordsSynced: 0,
      errors: [],
      duration: 0,
    });
    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(ensureProvider).not.toHaveBeenCalled();
  });

  it("fails loudly for an invalid stored timezone", async () => {
    const database = mockDatabase([[{ value: "Not/A_Timezone" }]]);

    await expect(
      new AutoSupplementsProvider().sync(
        new SyncRun({
          db: database,
          userId: USER_ID,
          window: SyncWindow.fromDateRange({
            sinceDate: "2026-07-20",
            untilDate: "2026-07-20",
          }),
        }),
      ),
    ).rejects.toThrow("Invalid stored timezone");
  });

  it("records past unresolved occurrences as unknown", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-21T12:00:00.000Z") });
    const database = mockDatabase([
      [{ value: "UTC" }],
      [
        {
          id: DEFINITION_ID,
          schedule_id: SCHEDULE_ID,
          effective_from: "2026-07-20",
          effective_to: null,
        },
      ],
      [{ id: "unknown-event" }],
      [],
    ]);

    await new AutoSupplementsProvider().sync(
      new SyncRun({
        db: database,
        userId: USER_ID,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-07-20",
          untilDate: "2026-07-20",
        }),
      }),
    );

    const calls = JSON.stringify(vi.mocked(database.execute).mock.calls);
    expect(calls).toContain("unknown");
  });

  it("applies definition dates inclusively at the start and exclusively at the end", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-21T12:00:00.000Z") });
    const database = mockDatabase([
      [{ value: "UTC" }],
      [
        {
          id: DEFINITION_ID,
          schedule_id: SCHEDULE_ID,
          effective_from: "2026-07-20",
          effective_to: "2026-07-23",
        },
      ],
      [{ id: "past-event" }, { id: "today-event" }, { id: "future-event" }],
      [{ id: "advanced-event" }],
    ]);

    const result = await new AutoSupplementsProvider().sync(
      new SyncRun({
        db: database,
        userId: USER_ID,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-07-19",
          untilDate: "2026-07-24",
        }),
      }),
    );

    const calls = vi.mocked(database.execute).mock.calls;
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls[2])).toContain("generate_series");
    expect(JSON.stringify(calls[2])).toContain("effective_to >");
    expect(JSON.stringify(calls[2])).toContain("unknown");
    expect(JSON.stringify(calls[2])).toContain("planned");
    expect(result).toEqual({
      provider: "auto-supplements",
      recordsSynced: 4,
      errors: [],
      duration: 0,
    });
  });

  it("keeps a definition without an end date effective after its start", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-21T12:00:00.000Z") });
    const database = mockDatabase([
      [{ value: "UTC" }],
      [
        {
          id: DEFINITION_ID,
          schedule_id: SCHEDULE_ID,
          effective_from: "2026-07-20",
          effective_to: null,
        },
      ],
      [{ id: "planned-event" }],
      [],
    ]);

    const result = await new AutoSupplementsProvider().sync(
      new SyncRun({
        db: database,
        userId: USER_ID,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-07-21",
          untilDate: "2026-07-21",
        }),
      }),
    );

    expect(database.execute).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(vi.mocked(database.execute).mock.calls[2])).toContain("planned");
    expect(result).toEqual({
      provider: "auto-supplements",
      recordsSynced: 1,
      errors: [],
      duration: 0,
    });
  });
});
