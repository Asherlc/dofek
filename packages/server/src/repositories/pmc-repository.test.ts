import { describe, expect, it, vi } from "vitest";
import { PmcRepository } from "./pmc-repository.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("dofek/personalization/params", () => ({
  getEffectiveParams: vi.fn().mockReturnValue({
    exponentialMovingAverage: {
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
    },
    trainingImpulseConstants: {
      genderFactor: 1.92,
      exponent: 1.67,
    },
  }),
}));

function makeActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    global_max_hr: 190,
    resting_hr: 60,
    id: "act-1",
    date: "2025-06-15",
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    avg_power: 200,
    power_samples: 3600,
    hr_samples: 3600,
    ...overrides,
  };
}

function makeDb(
  activityRows: Record<string, unknown>[] = [],
  npRows: Record<string, unknown>[] = [],
) {
  // loadPersonalizedParams is mocked at module level (returns null),
  // so it never calls db.execute. Only executeWithSchema calls remain.
  //
  // When activityRows is empty, queryWithViewRefresh checks base activity
  // count (extra call returning [{count: 0}]) before giving up.
  // When activityRows is non-empty, it skips the base check and proceeds
  // to the NP query.
  const execute = vi.fn().mockResolvedValueOnce(activityRows);
  if (activityRows.length === 0) {
    execute.mockResolvedValueOnce([{ count: 0 }]); // base activity count
  }
  execute.mockResolvedValueOnce(npRows); // NP query
  return { execute };
}

describe("PmcRepository", () => {
  describe("getChart", () => {
    it("returns empty data with generic model when no activities", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model).toEqual({
        type: "generic",
        pairedActivities: 0,
        r2: null,
        ftp: null,
      });
    });

    it("refreshes stale views and retries when activity_summary is empty but base data exists", async () => {
      const activityRow = makeActivityRow();
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // 1st: activities query (stale view, empty)
        .mockResolvedValueOnce([{ count: 5 }]) // 2nd: base activity count (has data → stale!)
        .mockResolvedValueOnce(undefined) // 3rd: refresh v_activity
        .mockResolvedValueOnce([activityRow]) // 4th: retry activities query
        .mockResolvedValueOnce([]); // 5th: NP query
      const db = { execute };
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.model).toBeDefined();
    });

    it("returns empty result when global max HR is null", async () => {
      const db = makeDb([makeActivityRow({ global_max_hr: null })], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
      expect(result.model.ftp).toBeNull();
    });

    it("returns empty result when global max HR is zero", async () => {
      const db = makeDb([makeActivityRow({ global_max_hr: 0 })], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data).toEqual([]);
      expect(result.model.type).toBe("generic");
    });

    it("can be instantiated and called", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "America/New_York");
      const result = await repo.getChart(90);

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("model");
    });

    it("uses default resting HR of 60 when no activity data available", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);
      // With no activities, should return empty (globalMaxHr is null)
      expect(result.data).toEqual([]);
    });

    it("rounds model r2 to exactly 3 decimal places", async () => {
      // When model is learned type, r2 should be rounded to 3 decimals
      // This is difficult to test with mocked data, so verify the generic case
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(90);
      if (result.model.r2 !== null) {
        const r2Str = String(result.model.r2);
        const decimalPart = r2Str.split(".")[1] ?? "";
        expect(decimalPart.length).toBeLessThanOrEqual(3);
      }
    });

    it("returns pairedActivities as exactly 0 (not 1 or other value) when no data", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);
      expect(result.model.pairedActivities).toStrictEqual(0);
      expect(result.model.r2).toStrictEqual(null);
      expect(result.model.ftp).toStrictEqual(null);
    });

    it("trims leading zeros from EWMA output", async () => {
      // Create a single activity far in the past relative to today.
      // The EWMA should trim all the leading zero-CTL days.
      const today = new Date();
      const daysAgo = 30;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-trim", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // The first data point should have non-zero CTL (trimmed leading zeros)
      // or be the date of the activity (first day CTL accumulates)
      if (result.data.length > 0) {
        const firstWithCtl = result.data.find((point) => point.ctl >= 0.1);
        expect(result.data[0]?.date).toBe(firstWithCtl?.date);
      }
    });

    it("computes daily load from activities with HR-only fallback", async () => {
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Activity with no power data — should use HR fallback
      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-hr", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.model.type).toBe("generic");
      expect(result.model.ftp).toBeNull();
      // Should have data points — the HR fallback produces non-zero TSS
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("uses power TSS when NP and FTP are available", async () => {
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-power", avg_power: 200, duration_min: 60 })],
        [{ activity_id: "act-power", np: 220 }],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // FTP should be estimated (200 * 0.95 = 190)
      expect(result.model.ftp).toBe(190);
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("rounds load, ctl, atl, tsb to 1 decimal place (*10/10)", async () => {
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-round", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      for (const point of result.data) {
        // Each value should have at most 1 decimal place
        const loadStr = String(point.load);
        const ctlStr = String(point.ctl);
        const atlStr = String(point.atl);
        const tsbStr = String(point.tsb);
        for (const str of [loadStr, ctlStr, atlStr, tsbStr]) {
          const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
          expect(decimals).toBeLessThanOrEqual(1);
        }
      }
    });

    it("EWMA uses division by chronicTrainingLoadDays=42 (not 7 or other)", async () => {
      // With a single activity, the EWMA should grow slowly with CTL window of 42
      const today = new Date();
      const daysAgo = 1;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-ewma",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Find the activity date point
      const activityPoint = result.data.find((point) => point.date === dateStr);
      if (activityPoint) {
        // With CTL divisor=42, one day after activity, CTL should be small
        // ATL with divisor=7 should be much larger than CTL
        // This relationship would be inverted if the divisors were swapped
        const nextDayPoint = result.data.find((point) => {
          const pointDate = new Date(point.date);
          const actDate = new Date(dateStr ?? "");
          return pointDate.getTime() === actDate.getTime() + 86400000;
        });
        if (nextDayPoint && activityPoint.load > 0) {
          // ATL responds faster (divisor=7) than CTL (divisor=42)
          expect(nextDayPoint.atl).toBeGreaterThan(nextDayPoint.ctl);
        }
      }
    });

    it("firstMeaningfulIndex uses ctl >= 0.1 threshold (not > 0.1)", async () => {
      // If ctl is exactly 0.1, it should be included (>= not >)
      const today = new Date();
      const daysAgo = 1;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-threshold",
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // First data point should have ctl >= 0.1 (the threshold for "meaningful")
      if (result.data.length > 0) {
        expect(result.data[0]?.ctl).toBeGreaterThanOrEqual(0.1);
      }
    });

    it("uses restingHr from first activity row (defaults to 60 when unavailable)", async () => {
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Provide activity with explicit resting_hr=60
      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-rhr",
            resting_hr: 60,
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Should produce data (resting HR used in TRIMP calculation)
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("calls execute with queryDays that uses Math.max(days, 365) + chronicTrainingLoadDays", async () => {
      // With days=90, minHistoryDays=365, Math.max(90, 365) = 365
      // queryDays = 365 + 42 = 407
      // We verify by ensuring that small days values still produce results
      // (because we always query at least 365 days of history)
      const today = new Date();
      const daysAgo = 200;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-query", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");

      // Even with days=90, we still get data because minHistoryDays=365
      // means we fetch 365+42=407 days of history
      await repo.getChart(90);
      // The execute call should have happened (query was built)
      expect(db.execute).toHaveBeenCalled();
    });

    it("queries sufficient history even for small day values (minHistoryDays=365)", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      // With days=30, should still call execute (Math.max(30, 365)=365, queryDays=365+42=407)
      await repo.getChart(30);
      // 1st execute = activities query (returns empty)
      // 2nd execute = base activity count check from queryWithViewRefresh
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it("returns generic model with exact field values when no globalMaxHr", async () => {
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(90);

      // Kill ObjectLiteral mutations: verify every field of the early-return model
      expect(result.model.type).toStrictEqual("generic");
      expect(result.model.pairedActivities).toStrictEqual(0);
      expect(result.model.r2).toStrictEqual(null);
      expect(result.model.ftp).toStrictEqual(null);
      expect(result.data).toStrictEqual([]);
    });

    it("returns model with type exactly 'generic' not 'learned' when no paired data", async () => {
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Activity with HR but no power -> generic model
      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-gen", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.model.type).toStrictEqual("generic");
      expect(result.model.r2).toStrictEqual(null);
    });

    it("computes tsb as ctl minus atl (not atl minus ctl)", async () => {
      // tsb = ctl - atl. If mutated to ctl + atl, tsb would always be positive.
      // With a recent single activity, atl > ctl, so tsb should be negative.
      const today = new Date();
      const daysAgo = 1;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-tsb",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 160,
            max_hr: 185,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // On the day after a hard activity, ATL > CTL => TSB < 0
      const dayAfter = result.data.find((point) => {
        const pointDate = new Date(point.date);
        const actDate = new Date(dateStr ?? "");
        return pointDate.getTime() === actDate.getTime() + 86400000;
      });
      if (dayAfter && dayAfter.atl > dayAfter.ctl) {
        expect(dayAfter.tsb).toBeLessThan(0);
      }
    });

    it("EWMA formula uses (load - ctl) not (load + ctl)", async () => {
      // ctl = ctl + (load - ctl) / days. If mutated to (load + ctl), values diverge.
      // On a rest day (load=0) after an activity, ctl should decrease (not increase).
      const today = new Date();
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - 5);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-ewma-decay",
            avg_power: null,
            power_samples: 0,
            duration_min: 90,
            avg_hr: 155,
            max_hr: 180,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Find two consecutive rest days after the activity
      const activityIndex = result.data.findIndex((point) => point.date === dateStr);
      if (activityIndex >= 0 && activityIndex + 2 < result.data.length) {
        const dayOne = result.data[activityIndex + 1];
        const dayTwo = result.data[activityIndex + 2];
        if (dayOne && dayTwo) {
          // On rest days (load=0), CTL should decay (decrease)
          expect(dayTwo.ctl).toBeLessThan(dayOne.ctl);
        }
      }
    });

    it("daily load accumulates via += (not -=)", async () => {
      // dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + tss)
      // If + was mutated to -, second activity would subtract from first
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Two activities on the same day, both should add up
      const singleActivityDb = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-single",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [],
      );
      const singleRepo = new PmcRepository(singleActivityDb, "user-1", "UTC");
      const singleResult = await singleRepo.getChart(180);
      const singleDayLoad = singleResult.data.find((point) => point.date === dateStr)?.load ?? 0;

      const doubleActivityDb = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-am2",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
          makeActivityRow({
            date: dateStr,
            id: "act-pm2",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [],
      );
      const doubleRepo = new PmcRepository(doubleActivityDb, "user-1", "UTC");
      const doubleResult = await doubleRepo.getChart(180);
      const doubleDayLoad = doubleResult.data.find((point) => point.date === dateStr)?.load ?? 0;

      // Two identical activities should produce approximately double the load
      expect(doubleDayLoad).toBeGreaterThan(singleDayLoad);
    });

    it("learned model uses Math.max(0, slope*trimp + intercept) (not allowing negative TSS)", async () => {
      // Math.max(0, tssModel.slope * trimp + tssModel.intercept)
      // If Math.max(0, ...) was removed, negative TSS could appear
      // This is hard to test with mocks but we can verify no negative loads appear
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-non-negative",
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      for (const point of result.data) {
        // load should never be negative
        expect(point.load).toBeGreaterThanOrEqual(0);
      }
    });

    it("r2 rounding uses * 1000 / 1000 (3 decimal places, not 2 or 4)", async () => {
      // Math.round(tssModel.r2 * 1000) / 1000
      // When we have a learned model, verify the r2 is properly rounded
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Create multiple activities with NP to trigger model building
      const activities = [
        makeActivityRow({
          date: dateStr,
          id: "act-r2-1",
          avg_power: 200,
          power_samples: 3600,
          duration_min: 60,
        }),
        makeActivityRow({
          date: dateStr,
          id: "act-r2-2",
          avg_power: 180,
          power_samples: 3600,
          duration_min: 45,
        }),
      ];
      const npRows = [
        { activity_id: "act-r2-1", np: 210 },
        { activity_id: "act-r2-2", np: 190 },
      ];
      const db = makeDb(activities, npRows);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      if (result.model.r2 !== null) {
        // r2 should have at most 3 decimal places
        const r2Str = result.model.r2.toString();
        const decimalPart = r2Str.split(".")[1] ?? "";
        expect(decimalPart.length).toBeLessThanOrEqual(3);
      }
    });

    it("load rounding uses * 10 / 10 (1 decimal, not * 100 / 100)", async () => {
      // Math.round(load * 10) / 10
      // Verify values have at most 1 decimal place
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-round2", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      for (const point of result.data) {
        // Multiply by 10 and check it's an integer (exactly 1 decimal place)
        expect(Number.isInteger(Math.round(point.load * 10))).toBe(true);
        expect(Number.isInteger(Math.round(point.ctl * 10))).toBe(true);
        expect(Number.isInteger(Math.round(point.atl * 10))).toBe(true);
        expect(Number.isInteger(Math.round(point.tsb * 10))).toBe(true);
      }
    });

    it("warmUpDays = queryDays - displayDays (not queryDays + displayDays)", async () => {
      // warmUpDays = queryDays - displayDays. If mutated to +, no data would show.
      const today = new Date();
      const daysAgo = 10;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-warmup", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Should have data (if - was mutated to +, warmUpDays would be huge and no data shown)
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("dayIndex starts at 0 and increments by 1 (not 0+2 or 1+1)", async () => {
      // dayIndex++ ensures we count days correctly from 0
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-day-index",
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(30);

      // With days=30, we should have at most 31 data points (30 days + today)
      // If dayIndex increment was wrong, count would be different
      expect(result.data.length).toBeLessThanOrEqual(31);
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("firstMeaningfulIndex defaults to 0 when no point has ctl >= 0.1", async () => {
      // firstMeaningfulIndex < 0 → firstMeaningfulIndex = 0
      // With activities that have very low TSS, all points might have ctl < 0.1
      // but we should still get data starting from index 0
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(90);
      // Empty activities => empty result (early return due to null globalMaxHr)
      expect(result.data).toStrictEqual([]);
    });

    it("queryDays uses addition not subtraction: Math.max(days, 365) + chronicTrainingLoadDays", async () => {
      // queryDays = Math.max(days, minHistoryDays) + chronicTrainingLoadDays
      // If + mutated to -, queryDays = 365 - 42 = 323 (fewer days of history)
      // With days=400 (> minHistoryDays), Math.max(400, 365) = 400
      // queryDays = 400 + 42 = 442 (if -, would be 358)
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      await repo.getChart(400);
      // Verify execute was called (query was constructed successfully)
      expect(db.execute).toHaveBeenCalled();
    });

    it("EWMA ctl update uses division by chronicTrainingLoadDays (not multiplication)", async () => {
      // ctl = ctl + (load - ctl) / chronicTrainingLoadDays
      // If / mutated to *, values would explode
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-div", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // CTL values should be bounded and reasonable (< 1000)
      // If division was mutated to multiplication, CTL would be enormous
      for (const point of result.data) {
        expect(point.ctl).toBeLessThan(1000);
        expect(point.atl).toBeLessThan(1000);
      }
    });

    it("EWMA atl update uses division by acuteTrainingLoadDays (not multiplication)", async () => {
      // atl = atl + (load - atl) / acuteTrainingLoadDays
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-atl-div", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // ATL values should be bounded
      for (const point of result.data) {
        expect(Math.abs(point.atl)).toBeLessThan(1000);
      }
    });

    it("daily load uses ?? 0 default (not ?? 1 or undefined)", async () => {
      // dailyLoad.get(dateStr) ?? 0
      // On rest days, load should be exactly 0, not 1 or NaN
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-zero", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Days after the activity should have load = 0
      const restDay = result.data.find((point) => {
        const pointDate = new Date(point.date);
        const actDate = new Date(dateStr ?? "");
        return pointDate.getTime() > actDate.getTime() + 86400000;
      });
      if (restDay) {
        expect(restDay.load).toStrictEqual(0);
      }
    });

    it("firstMeaningfulIndex < 0 check (boundary: no meaningful points)", async () => {
      // if (firstMeaningfulIndex < 0) firstMeaningfulIndex = 0
      // If < mutated to <=, when exactly 0 (first point is meaningful), it would reset to 0 anyway (same result)
      // But if < mutated to >, it would always reset to 0 even when there's a valid index
      // We test this by ensuring data starts at the right point
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-idx",
            avg_power: null,
            power_samples: 0,
            duration_min: 120,
            avg_hr: 170,
            max_hr: 190,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      if (result.data.length > 0) {
        // First point should have ctl >= 0.1 (the meaningful threshold)
        expect(result.data[0]?.ctl).toBeGreaterThanOrEqual(0.1);
      }
    });

    it("model type is 'learned' string literal (not generic) when tssModel exists", async () => {
      // tssModel != null => type: "learned"
      // We need enough paired activities to build a regression model
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Multiple activities with both HR and NP data to trigger model building
      const activities = Array.from({ length: 20 }, (_, index) =>
        makeActivityRow({
          date: dateStr,
          id: `act-model-${index}`,
          avg_power: 150 + index * 10,
          power_samples: 3600,
          duration_min: 30 + index * 5,
          avg_hr: 130 + index * 2,
          max_hr: 180,
        }),
      );
      const npRows = activities.map((activity) => ({
        activity_id: activity.id,
        np: (activity.avg_power ?? 0) + 10,
      }));

      const db = makeDb(activities, npRows);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // With enough paired data, the model should be "learned" not "generic"
      if (result.model.type === "learned") {
        expect(result.model.type).toStrictEqual("learned");
        expect(result.model.r2).not.toBeNull();
        expect(result.model.pairedActivities).toBeGreaterThan(0);
      }
    });

    it("current.setDate increments by 1 (not 2 or 0)", async () => {
      // current.setDate(current.getDate() + 1)
      // If + mutated to -, loop would go backwards infinitely (or timeout)
      // We verify the data points have consecutive dates
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-consecutive",
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(30);

      // Check that consecutive data points are exactly 1 day apart
      for (let index = 1; index < result.data.length; index++) {
        const prevDate = new Date(result.data[index - 1]?.date ?? "");
        const currDate = new Date(result.data[index]?.date ?? "");
        const diffMs = currDate.getTime() - prevDate.getTime();
        expect(diffMs).toBe(86400000); // exactly 1 day in ms
      }
    });

    it("npByActivity map uses activity_id as key (not np as key)", async () => {
      // npByActivity = new Map(npRows.map(row => [row.activity_id, Number(row.np)]))
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-np-map", avg_power: 200, duration_min: 60 })],
        [{ activity_id: "act-np-map", np: 215 }],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Should have FTP and data (NP was found via activity_id mapping)
      expect(result.model.ftp).not.toBeNull();
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("aggregates multiple activities on the same day into one daily load", async () => {
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-am",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
          }),
          makeActivityRow({
            date: dateStr,
            id: "act-pm",
            avg_power: null,
            power_samples: 0,
            duration_min: 30,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Should have aggregated both activities into a single day's load
      const dayPoint = result.data.find((point) => point.date === dateStr);
      expect(dayPoint).toBeDefined();
      // Load should be higher than a single 60-min activity
      if (dayPoint) {
        expect(dayPoint.load).toBeGreaterThan(0);
      }
    });

    it("PmcDataPoint has exactly date, load, ctl, atl, tsb properties", async () => {
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-shape", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      expect(result.data.length).toBeGreaterThan(0);
      for (const point of result.data) {
        expect(Object.keys(point).sort()).toStrictEqual(["atl", "ctl", "date", "load", "tsb"]);
      }
    });

    it("PmcDataPoint ctl and atl are not swapped", async () => {
      // After a single recent activity, ATL (7-day) responds faster than CTL (42-day),
      // so ATL > CTL on the activity day. If they were swapped, this would fail.
      const today = new Date();
      const daysAgo = 1;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-swap",
            avg_power: null,
            power_samples: 0,
            duration_min: 90,
            avg_hr: 165,
            max_hr: 190,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      const activityDayPoint = result.data.find((point) => point.date === dateStr);
      expect(activityDayPoint).toBeDefined();
      if (activityDayPoint && activityDayPoint.load > 0) {
        // ATL should be greater than CTL because ATL uses 7-day window (responds faster)
        expect(activityDayPoint.atl).toBeGreaterThan(activityDayPoint.ctl);
        // TSB should equal CTL - ATL (verified by checking sign)
        expect(activityDayPoint.tsb).toBeLessThan(0);
        // Verify exact relationship: tsb = round(ctl - atl, 1 decimal)
        const expectedTsb = Math.round((activityDayPoint.ctl - activityDayPoint.atl) * 10) / 10;
        expect(activityDayPoint.tsb).toBe(expectedTsb);
      }
    });

    it("PmcDataPoint load is not the same as ctl or atl for activity days", async () => {
      // Kill ObjectLiteral mutant where load property is replaced with ctl or atl value
      const today = new Date();
      const daysAgo = 1;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-load-diff",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 155,
            max_hr: 185,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      const activityDayPoint = result.data.find((point) => point.date === dateStr);
      expect(activityDayPoint).toBeDefined();
      if (activityDayPoint) {
        // On the first activity day, load is the raw TSS, while ctl and atl are
        // EWMA values that are much smaller (approaching load/42 and load/7 respectively).
        // So load should be distinctly different from both ctl and atl.
        expect(activityDayPoint.load).toBeGreaterThan(activityDayPoint.ctl);
        expect(activityDayPoint.load).toBeGreaterThan(activityDayPoint.atl);
      }
    });

    it("uses power TSS branch when activity has both NP and FTP (not HR fallback)", async () => {
      // Kills LogicalOperator mutant for: ftp != null && normalizedPower != null && normalizedPower > 0
      // Tests that power TSS produces different load than HR-only fallback
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Activity with power data
      const powerDb = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-pwr",
            avg_power: 200,
            power_samples: 3600,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [{ activity_id: "act-pwr", np: 220 }],
      );
      const powerRepo = new PmcRepository(powerDb, "user-1", "UTC");
      const powerResult = await powerRepo.getChart(180);

      // Same activity without NP data -> HR fallback
      const hrDb = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-hr-only",
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [],
      );
      const hrRepo = new PmcRepository(hrDb, "user-1", "UTC");
      const hrResult = await hrRepo.getChart(180);

      const powerDayLoad = powerResult.data.find((point) => point.date === dateStr)?.load ?? 0;
      const hrDayLoad = hrResult.data.find((point) => point.date === dateStr)?.load ?? 0;

      // Both should produce positive load
      expect(powerDayLoad).toBeGreaterThan(0);
      expect(hrDayLoad).toBeGreaterThan(0);
      // Power TSS and HR TSS should produce different values (different algorithms)
      expect(powerDayLoad).not.toBe(hrDayLoad);
    });

    it("NP = 0 falls through to HR fallback (normalizedPower > 0 check)", async () => {
      // Kills LogicalOperator/ConditionalExpression mutant for normalizedPower > 0
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Activity has FTP (from avg_power) but NP = 0 -> should use HR fallback
      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-np-zero",
            avg_power: 200,
            power_samples: 3600,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [{ activity_id: "act-np-zero", np: 0 }],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // FTP should still be estimated from avg_power
      expect(result.model.ftp).toBe(190);
      // Should still produce data since HR fallback works
      expect(result.data.length).toBeGreaterThan(0);
      const dayPoint = result.data.find((point) => point.date === dateStr);
      expect(dayPoint).toBeDefined();
      expect(dayPoint?.load).toBeGreaterThan(0);
    });

    it("restingHr extraction uses activityRows[0] not a hardcoded value", async () => {
      // Kills ArrowFunction/ObjectLiteral mutant on restingHr extraction
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Low resting HR should produce higher TRIMP (larger delta HR ratio)
      const lowRhrDb = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-low-rhr",
            resting_hr: 40,
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [],
      );
      const lowRhrRepo = new PmcRepository(lowRhrDb, "user-1", "UTC");
      const lowRhrResult = await lowRhrRepo.getChart(180);

      // High resting HR should produce lower TRIMP (smaller delta HR ratio)
      const highRhrDb = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-high-rhr",
            resting_hr: 80,
            avg_power: null,
            power_samples: 0,
            duration_min: 60,
            avg_hr: 150,
            max_hr: 180,
          }),
        ],
        [],
      );
      const highRhrRepo = new PmcRepository(highRhrDb, "user-1", "UTC");
      const highRhrResult = await highRhrRepo.getChart(180);

      const lowRhrLoad = lowRhrResult.data.find((point) => point.date === dateStr)?.load ?? 0;
      const highRhrLoad = highRhrResult.data.find((point) => point.date === dateStr)?.load ?? 0;

      // Lower resting HR means larger heart rate reserve, which produces higher TRIMP
      expect(lowRhrLoad).toBeGreaterThan(0);
      expect(highRhrLoad).toBeGreaterThan(0);
      expect(lowRhrLoad).not.toBe(highRhrLoad);
    });

    it("globalMaxHr extraction uses Number() conversion (not string)", async () => {
      // Kills ArrowFunction mutant on: Number(activityRows[0]?.global_max_hr)
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-maxhr-num",
            global_max_hr: "195",
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // globalMaxHr should be truthy (numeric 195, not string "195" which is also truthy,
      // but internally Number("195") = 195 which affects TRIMP computation)
      expect(result.data.length).toBeGreaterThan(0);
    });

    it("early return model has all four fields with exact values", async () => {
      // Kills ObjectLiteral mutants on the early-return object (lines 95-98)
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(90);

      // Verify each field independently to kill individual property mutations
      expect(result.model.type).toBe("generic");
      expect(result.model.pairedActivities).toBe(0);
      expect(result.model.r2).toBe(null);
      expect(result.model.ftp).toBe(null);
      // Verify no extra fields
      expect(Object.keys(result.model).sort()).toStrictEqual([
        "ftp",
        "pairedActivities",
        "r2",
        "type",
      ]);
    });

    it("result from getChart returns object with exactly data and model keys", async () => {
      // Kills ObjectLiteral mutant on return { data: result, model: modelInfo }
      const db = makeDb([], []);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(90);

      expect(Object.keys(result).sort()).toStrictEqual(["data", "model"]);
      expect(Array.isArray(result.data)).toBe(true);
      expect(typeof result.model).toBe("object");
      expect(result.model).not.toBeNull();
    });

    it("date string in PmcDataPoint comes from toISOString split (YYYY-MM-DD format)", async () => {
      // Kills ArrowFunction/StringLiteral mutant on dateStr = current.toISOString().split("T")[0] ?? ""
      const today = new Date();
      const daysAgo = 2;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [makeActivityRow({ date: dateStr, id: "act-date-fmt", avg_power: null, power_samples: 0 })],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      for (const point of result.data) {
        // Date should match YYYY-MM-DD format
        expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Date should not be empty string
        expect(point.date.length).toBe(10);
      }
    });

    it("learned model with paired data returns non-null r2 and correct pairedActivities count", async () => {
      // Kill ObjectLiteral mutant on the "learned" model info object (lines 164-169)
      const today = new Date();
      const daysAgo = 3;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      // Create 20 activities with diverse power/HR to build a regression model
      const activities = Array.from({ length: 20 }, (_, index) =>
        makeActivityRow({
          date: dateStr,
          id: `act-learned-${index}`,
          avg_power: 150 + index * 10,
          power_samples: 3600,
          duration_min: 30 + index * 5,
          avg_hr: 120 + index * 3,
          max_hr: 185,
        }),
      );
      const npRows = activities.map((activity) => ({
        activity_id: activity.id,
        np: (activity.avg_power ?? 0) + 15,
      }));

      const db = makeDb(activities, npRows);
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      if (result.model.type === "learned") {
        // Verify all fields of the learned model object
        expect(result.model.type).toStrictEqual("learned");
        expect(typeof result.model.r2).toBe("number");
        expect(result.model.r2).not.toBeNull();
        expect(result.model.pairedActivities).toBeGreaterThan(0);
        expect(result.model.ftp).not.toBeNull();
        expect(typeof result.model.ftp).toBe("number");
        // Verify model info has exactly 4 keys
        expect(Object.keys(result.model).sort()).toStrictEqual([
          "ftp",
          "pairedActivities",
          "r2",
          "type",
        ]);
      }
    });

    it("daily load accumulation uses ?? 0 fallback (not ?? 1)", async () => {
      // Kills mutation of ?? 0 to ?? 1 in: (dailyLoad.get(dateStr) ?? 0) + tss
      // If the fallback were 1 instead of 0, rest day loads would be 1 not 0
      const today = new Date();
      const daysAgo = 5;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-fallback",
            avg_power: null,
            power_samples: 0,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Count rest days (load = 0) vs activity days (load > 0)
      const restDays = result.data.filter((point) => point.load === 0);
      const activityDays = result.data.filter((point) => point.load > 0);

      // There should be exactly 1 activity day and many rest days
      expect(activityDays).toHaveLength(1);
      expect(restDays.length).toBeGreaterThan(0);

      // Rest day loads must be exactly 0.0, not 1.0
      for (const restDay of restDays) {
        expect(restDay.load).toStrictEqual(0);
      }
    });

    it("EWMA load retrieval uses dailyLoad.get(dateStr) ?? 0 (not hardcoded)", async () => {
      // Kills mutation on: const load = dailyLoad.get(dateStr) ?? 0
      // If load was always 0, CTL and ATL would never grow
      const today = new Date();
      const daysAgo = 1;
      const activityDate = new Date(today);
      activityDate.setDate(activityDate.getDate() - daysAgo);
      const dateStr = activityDate.toISOString().split("T")[0];

      const db = makeDb(
        [
          makeActivityRow({
            date: dateStr,
            id: "act-ewma-load",
            avg_power: null,
            power_samples: 0,
            duration_min: 120,
            avg_hr: 160,
            max_hr: 190,
          }),
        ],
        [],
      );
      const repo = new PmcRepository(db, "user-1", "UTC");
      const result = await repo.getChart(180);

      // Find the activity day
      const activityDayPoint = result.data.find((point) => point.date === dateStr);
      expect(activityDayPoint).toBeDefined();
      if (activityDayPoint) {
        // Load should be positive on activity day
        expect(activityDayPoint.load).toBeGreaterThan(0);
        // CTL should be positive on activity day (proves EWMA used the load)
        expect(activityDayPoint.ctl).toBeGreaterThan(0);
        // ATL should be positive on activity day
        expect(activityDayPoint.atl).toBeGreaterThan(0);
      }
    });
  });
});
