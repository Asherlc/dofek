import { randomUUID } from "node:crypto";
import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { SportSettingsRepository } from "../repositories/sport-settings-repository.ts";
import { sportSettingsRouter } from "./sport-settings.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(sportSettingsRouter);
const OTHER_USER_ID = randomUUID();
const FTP_TEST_DATE = "2040-01-01";
const TEST_CACHE_KEYS = [
  `${TEST_USER_ID}:sportSettings.list`,
  `${TEST_USER_ID}:activity.powerZones`,
  `${TEST_USER_ID}:calendar.activityOverview`,
  `${TEST_USER_ID}:cycling.performance`,
  `${TEST_USER_ID}:pmc.chart`,
];

describe("sport settings FTP integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (${OTHER_USER_ID}, 'FTP Test User', ${`ftp-${OTHER_USER_ID}@example.test`})`,
    );
  });

  beforeEach(async () => {
    await testContext.db.execute(
      sql`DELETE FROM fitness.sport_settings
          WHERE user_id = ${TEST_USER_ID}::uuid AND sport = 'cycling'`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.sport_settings
          WHERE user_id = ${OTHER_USER_ID}::uuid AND sport = 'cycling'`,
    );
    await queryCache.invalidateAll();
  });

  afterAll(async () => {
    await queryCache.invalidateAll();
    await testContext?.cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function caller(userId = TEST_USER_ID, timezone = "UTC") {
    return createCaller({ db: testContext.db, userId, timezone });
  }

  it("updates a same-date FTP without erasing other fields and inherits prior snapshots", async () => {
    const repository = caller();
    const created = await repository.upsert({
      sport: "cycling",
      thresholdHr: 164,
      thresholdPacePerKm: 4.2,
      powerZonePcts: [0.5, 0.75, 0.9],
      hrZonePcts: [0.6, 0.8, 0.95],
      notes: "Keep these settings",
      ftp: 280,
      effectiveFrom: FTP_TEST_DATE,
    });
    const sameDate = await repository.upsert({
      sport: "cycling",
      ftp: 180,
      effectiveFrom: FTP_TEST_DATE,
    });

    expect(sameDate).toMatchObject({
      id: created.id,
      ftp: 180,
      thresholdHr: 164,
      thresholdPacePerKm: 4.2,
      powerZonePcts: [0.5, 0.75, 0.9],
      hrZonePcts: [0.6, 0.8, 0.95],
      notes: "Keep these settings",
    });

    const later = await repository.upsert({
      sport: "cycling",
      ftp: 175,
      effectiveFrom: "2040-06-01",
    });
    expect(later).toMatchObject({
      ftp: 175,
      thresholdHr: 164,
      thresholdPacePerKm: 4.2,
      powerZonePcts: [0.5, 0.75, 0.9],
      hrZonePcts: [0.6, 0.8, 0.95],
      notes: "Keep these settings",
    });

    const cleared = await repository.upsert({
      sport: "cycling",
      ftp: null,
      effectiveFrom: "2040-09-01",
    });
    expect(cleared.ftp).toBeNull();
    expect(
      (await repository.getBySport({ sport: "cycling", asOfDate: "2040-09-01" }))?.ftp,
    ).toBeNull();

    await repository.delete({ id: cleared.id });
    const persisted = new SportSettingsRepository(testContext.db, TEST_USER_ID);
    expect((await persisted.getBySport("cycling", "2040-09-01"))?.ftp).toBe(175);
  });

  it("preserves concurrent partial saves to the same effective date", async () => {
    const repository = caller();
    await repository.upsert({
      sport: "cycling",
      ftp: 280,
      thresholdHr: 164,
      effectiveFrom: FTP_TEST_DATE,
    });

    await Promise.all([
      repository.upsert({ sport: "cycling", ftp: 275, effectiveFrom: "2040-06-01" }),
      repository.upsert({ sport: "cycling", thresholdHr: 168, effectiveFrom: "2040-06-01" }),
    ]);

    expect(await repository.getBySport({ sport: "cycling", asOfDate: "2040-06-01" })).toMatchObject(
      {
        ftp: 275,
        thresholdHr: 168,
      },
    );
  });

  it("excludes future settings from current reads", async () => {
    const repository = caller();
    const today = formatDateYmdInTimeZone(new Date(), "UTC");
    await repository.upsert({ sport: "cycling", ftp: 260, effectiveFrom: today });
    const future = await repository.upsert({
      sport: "cycling",
      ftp: 300,
      effectiveFrom: "2099-01-01",
    });

    expect((await repository.list()).find((row) => row.sport === "cycling")?.effectiveFrom).toBe(
      today,
    );
    expect((await repository.getBySport({ sport: "cycling" }))?.effectiveFrom).toBe(today);
    expect((await repository.getBySport({ sport: "cycling", asOfDate: "2099-01-01" }))?.id).toBe(
      future.id,
    );
  });

  it("expires warmed current reads at the request timezone's local midnight", async () => {
    const repository = caller(TEST_USER_ID, "America/Los_Angeles");
    await repository.upsert({ sport: "cycling", ftp: 250, effectiveFrom: "2026-07-08" });
    await repository.upsert({ sport: "cycling", ftp: null, effectiveFrom: "2026-07-09" });
    await queryCache.invalidateAll();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-09T06:59:58.000Z"));
    expect((await repository.list()).find((row) => row.sport === "cycling")?.ftp).toBe(250);
    expect((await repository.getBySport({ sport: "cycling" }))?.ftp).toBe(250);

    vi.setSystemTime(new Date("2026-07-09T07:00:02.000Z"));
    expect((await repository.list()).find((row) => row.sport === "cycling")?.ftp).toBeNull();
    expect((await repository.getBySport({ sport: "cycling" }))?.ftp).toBeNull();
  });

  it("uses the request timezone for an omitted effective date", async () => {
    const timezone = "Pacific/Kiritimati";
    const row = await caller(TEST_USER_ID, timezone).upsert({ sport: "running", thresholdHr: 150 });
    expect(row.effectiveFrom).toBe(formatDateYmdInTimeZone(new Date(), timezone));
  });

  it("validates FTP as a positive whole number and isolates users", async () => {
    const repository = caller();
    await expect(
      repository.upsert({ sport: "cycling", ftp: 0, effectiveFrom: FTP_TEST_DATE }),
    ).rejects.toThrow();
    await expect(
      repository.upsert({ sport: "cycling", ftp: 250.5, effectiveFrom: FTP_TEST_DATE }),
    ).rejects.toThrow();

    await caller(OTHER_USER_ID).upsert({
      sport: "cycling",
      ftp: 320,
      effectiveFrom: FTP_TEST_DATE,
    });
    expect(await repository.getBySport({ sport: "cycling", asOfDate: FTP_TEST_DATE })).toBeNull();
    expect(
      (await caller(OTHER_USER_ID).getBySport({ sport: "cycling", asOfDate: FTP_TEST_DATE }))?.ftp,
    ).toBe(320);
  });

  it("creates a validated bigint FTP column that stores values and nullable clears", async () => {
    const schema = await executeWithSchema(
      testContext.db,
      z.object({ data_type: z.string(), convalidated: z.boolean() }),
      sql`
        SELECT column_info.data_type, constraint_info.convalidated
        FROM information_schema.columns AS column_info
        JOIN pg_constraint AS constraint_info
          ON constraint_info.conname = 'sport_settings_ftp_positive'
          AND constraint_info.conrelid = 'fitness.sport_settings'::regclass
        WHERE column_info.table_schema = 'fitness'
          AND column_info.table_name = 'sport_settings'
          AND column_info.column_name = 'ftp'
      `,
    );
    expect(schema).toEqual([{ data_type: "bigint", convalidated: true }]);

    const repository = caller();
    expect(
      (
        await repository.upsert({
          sport: "ftp-storage-check",
          ftp: 400,
          effectiveFrom: FTP_TEST_DATE,
        })
      ).ftp,
    ).toBe(400);
    const aboveIntRange = 2_147_483_648;
    expect(
      (
        await repository.upsert({
          sport: "ftp-large-value-check",
          ftp: aboveIntRange,
          effectiveFrom: FTP_TEST_DATE,
        })
      ).ftp,
    ).toBe(aboveIntRange);
    expect(
      (
        await repository.upsert({
          sport: "ftp-storage-check",
          ftp: null,
          effectiveFrom: FTP_TEST_DATE,
        })
      ).ftp,
    ).toBeNull();

    await expect(
      testContext.db.execute(sql`
        INSERT INTO fitness.sport_settings (user_id, sport, ftp, effective_from)
        VALUES (${TEST_USER_ID}::uuid, 'ftp-constraint-check', 0, ${FTP_TEST_DATE}::date)
      `),
    ).rejects.toThrow();
  });

  it("invalidates settings and dependent activity, calendar, cycling, and PMC cache entries", async () => {
    await Promise.all(TEST_CACHE_KEYS.map((key) => queryCache.set(key, "stale", 60_000)));

    await caller().upsert({ sport: "cycling", ftp: 260, effectiveFrom: FTP_TEST_DATE });

    await Promise.all(
      TEST_CACHE_KEYS.map(async (key) => {
        await expect(queryCache.get(key)).resolves.toBeUndefined();
      }),
    );
  });
});
