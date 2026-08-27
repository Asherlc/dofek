import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  fetchRestingHeartRateRows,
  localDateString,
  representativeRestingHeartRate,
  restingHeartRateClickHouseCte,
} from "./resting-heart-rate-query.ts";

describe("fetchRestingHeartRateRows", () => {
  it("queries the incremental ClickHouse resting heart rate read model", async () => {
    const query = vi.fn().mockResolvedValue([{ date: "2026-05-01", resting_hr: 52 }]);
    const sensorStore = { query };

    const rows = await fetchRestingHeartRateRows({
      sensorStore,
      userId: "user-1",
      timezone: "America/Los_Angeles",
      endDate: "2026-05-07",
      days: 30,
    });

    expect(rows).toEqual([{ date: "2026-05-01", resting_hr: 52 }]);
    expect(query).toHaveBeenCalledTimes(1);

    const queryText = String(query.mock.calls[0]?.[1]);
    expect(queryText).toContain("FROM analytics.resting_heart_rate_sleep_window FINAL");
    expect(queryText).toContain("WHERE user_id = {userId:UUID}");
    expect(queryText).toContain("is_deleted = 0");
    expect(queryText).toContain("toDate(toTimeZone(ended_at, {timezone:String}))");
    expect(queryText).toContain("LIMIT 1 BY user_id, date");
    expect(queryText).not.toContain("channel = 'heart_rate'");
    expect(queryText).not.toContain("analytics.deduped_sensor");
    expect(queryText).not.toContain("analytics.v_sleep");
    expect(queryText).not.toContain("derived_resting_heart_rate");
  });
});

describe("restingHeartRateClickHouseCte", () => {
  it("includes the window start predicate by default", () => {
    const cteSql = restingHeartRateClickHouseCte();

    expect(cteSql).toContain("toDate({rhrWindowStart:String})");
  });

  it("omits the window start predicate for unbounded queries", () => {
    const cteSql = restingHeartRateClickHouseCte({ includeWindowStart: false });

    expect(cteSql).not.toContain("toDate({rhrWindowStart:String})");
  });
});

describe("localDateString", () => {
  it("formats dates from named Intl parts rather than part order", () => {
    const dateTimeFormatSpy = mockDateTimeFormatParts([
      { type: "year", value: "2026" },
      { type: "literal", value: "-" },
      { type: "day", value: "20" },
      { type: "literal", value: "-" },
      { type: "month", value: "05" },
    ]);

    expect(localDateString(new Date("2026-05-20T15:45:00Z"), "UTC")).toBe("2026-05-20");

    dateTimeFormatSpy.mockRestore();
  });

  it.each([
    [
      "year",
      [
        { type: "month", value: "05" },
        { type: "day", value: "20" },
      ],
    ],
    [
      "month",
      [
        { type: "year", value: "2026" },
        { type: "day", value: "20" },
      ],
    ],
    [
      "day",
      [
        { type: "year", value: "2026" },
        { type: "month", value: "05" },
      ],
    ],
  ])("falls back to the ISO date when the %s part is missing", (_, parts) => {
    const dateTimeFormatSpy = mockDateTimeFormatParts(parts);

    expect(localDateString(new Date("2026-05-20T15:45:00Z"), "UTC")).toBe("2026-05-20");

    dateTimeFormatSpy.mockRestore();
  });
});

function mockDateTimeFormatParts(parts: Intl.DateTimeFormatPart[]) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
  vi.spyOn(formatter, "formatToParts").mockReturnValue(parts);
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
    class {
      constructor() {
        return formatter;
      }
    },
  );
}

describe("representativeRestingHeartRate", () => {
  it("returns null when no rows are provided", () => {
    expect(representativeRestingHeartRate([])).toBeNull();
  });

  it("returns the single value when there is one row", () => {
    expect(representativeRestingHeartRate([{ date: "2026-05-04", resting_hr: 55 }])).toBe(55);
  });

  it("medians an odd-length window", () => {
    const rows = [
      { date: "2026-05-01", resting_hr: 55 },
      { date: "2026-05-02", resting_hr: 57 },
      { date: "2026-05-03", resting_hr: 56 },
    ];
    expect(representativeRestingHeartRate(rows)).toBe(56);
  });

  it("averages the two middle values for an even-length window", () => {
    const rows = [
      { date: "2026-05-01", resting_hr: 55 },
      { date: "2026-05-02", resting_hr: 57 },
      { date: "2026-05-03", resting_hr: 55 },
      { date: "2026-05-04", resting_hr: 59 },
    ];
    expect(representativeRestingHeartRate(rows)).toBe(56);
  });

  it("suppresses a single noisy night surrounded by stable readings", () => {
    // Matches the prod scenario: Apr 26-28 ≈ 55-57 bpm, then May 4 spikes to 85.
    // The old `.at(-1)` picked 85 and broke HR zones for every later activity.
    const rows = [
      { date: "2026-04-26", resting_hr: 55 },
      { date: "2026-04-27", resting_hr: 57 },
      { date: "2026-04-28", resting_hr: 55 },
      { date: "2026-05-04", resting_hr: 85 },
    ];
    expect(representativeRestingHeartRate(rows)).toBe(56);
  });

  it("uses only the most recent sampleWindow rows", () => {
    const rows = [
      { date: "2025-12-01", resting_hr: 100 },
      { date: "2025-12-02", resting_hr: 100 },
      { date: "2026-05-01", resting_hr: 55 },
      { date: "2026-05-02", resting_hr: 56 },
      { date: "2026-05-03", resting_hr: 57 },
    ];
    expect(representativeRestingHeartRate(rows, 3)).toBe(56);
  });

  it("uses the most recent positive readings when invalid readings trail the window", () => {
    const rows = [
      { date: "2026-05-01", resting_hr: 55 },
      { date: "2026-05-02", resting_hr: 57 },
      { date: "2026-05-03", resting_hr: 0 },
      { date: "2026-05-04", resting_hr: -1 },
    ];
    expect(representativeRestingHeartRate(rows, 2)).toBe(56);
  });

  it("returns null when sampleWindow is not positive", () => {
    const rows = [{ date: "2026-05-01", resting_hr: 55 }];
    expect(representativeRestingHeartRate(rows, 0)).toBeNull();
    expect(representativeRestingHeartRate(rows, -1)).toBeNull();
  });

  it("ignores non-positive readings", () => {
    const rows = [
      { date: "2026-05-01", resting_hr: 0 },
      { date: "2026-05-02", resting_hr: 56 },
      { date: "2026-05-03", resting_hr: 58 },
    ];
    expect(representativeRestingHeartRate(rows)).toBe(57);
  });

  it("returns null when every reading is non-positive", () => {
    const rows = [
      { date: "2026-05-01", resting_hr: 0 },
      { date: "2026-05-02", resting_hr: -5 },
    ];
    expect(representativeRestingHeartRate(rows)).toBeNull();
  });
});

describe("resting heart rate architecture", () => {
  it("does not allow runtime code to compute resting heart rate from Postgres", () => {
    const repositoriesDir = dirname(fileURLToPath(import.meta.url));
    const sourceDir = dirname(repositoriesDir);
    const repoRoot = join(sourceDir, "../../..");
    const runtimeFiles = [
      ...collectRuntimeTypeScriptFiles(sourceDir),
      ...collectRuntimeTypeScriptFiles(join(repoRoot, "src/personalization")),
    ];

    const offenders = runtimeFiles
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(
        ({ source }) =>
          source.includes("restingHeartRatePostgresCte") ||
          source.includes("restingHeartRateLateral") ||
          source.includes("fitness.derived_resting_heart_rate") ||
          source.includes("analytics.derived_resting_heart_rate"),
      )
      .map(({ filePath }) => filePath.replace(`${repoRoot}/`, ""));

    expect(offenders).toEqual([]);
  });
});

function collectRuntimeTypeScriptFiles(directoryPath: string): string[] {
  const entries = readdirSync(directoryPath);
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      filePaths.push(...collectRuntimeTypeScriptFiles(entryPath));
      continue;
    }

    if (
      entryPath.endsWith(".ts") &&
      !entryPath.endsWith(".test.ts") &&
      !entryPath.endsWith(".integration.test.ts") &&
      !entryPath.endsWith(".test-helpers.ts")
    ) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}
