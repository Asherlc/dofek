import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { fetchRestingHeartRateRows } from "./resting-heart-rate-query.ts";

describe("fetchRestingHeartRateRows", () => {
  it("queries raw ClickHouse sleep and heart-rate samples instead of derived RHR read models", async () => {
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
    expect(queryText).toContain("analytics.v_sleep");
    expect(queryText).toContain("analytics.deduped_sensor");
    expect(queryText).toContain("channel = 'heart_rate'");
    expect(queryText).toContain("arraySort");
    expect(queryText).toContain("arraySlice");
    expect(queryText).not.toContain("derived_resting_heart_rate");
  });
});

describe("resting heart rate architecture", () => {
  it("does not allow runtime code to compute resting heart rate from Postgres", () => {
    const repositoriesDir = dirname(fileURLToPath(import.meta.url));
    const sourceDir = dirname(repositoriesDir);
    const runtimeFiles = collectRuntimeTypeScriptFiles(sourceDir);

    const offenders = runtimeFiles
      .map((filePath) => ({
        filePath,
        source: readFileSync(filePath, "utf8"),
      }))
      .filter(
        ({ source }) =>
          source.includes("restingHeartRatePostgresCte") ||
          source.includes("restingHeartRateLateral"),
      )
      .map(({ filePath }) => filePath.replace(`${sourceDir}/`, ""));

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
