import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SELECTED_CHART_RANGE_ENDPOINTS } from "./date-window.ts";

const serverSourceRoot = join(process.cwd(), "packages/server/src");

function readServerSource(relativePath: string): string {
  return readFileSync(join(serverSourceRoot, relativePath), "utf8");
}

describe("selected chart range policy", () => {
  it("requires every selected chart range endpoint to name its central range contract in its router", () => {
    for (const [endpoint, contract] of Object.entries(SELECTED_CHART_RANGE_ENDPOINTS)) {
      const routerSource = readServerSource(join("routers", contract.routerFile));
      const builderByInput = {
        days: "selectedChartRangeQuery",
        dateRange: "selectedChartDateRangeQuery",
        custom: "selectedChartCustomRangeQuery",
      } as const;
      const builder = builderByInput[contract.input];

      expect(routerSource, `${endpoint} must be declared through ${builder}`).toMatch(
        new RegExp(`${builder}\\(\\s*"${endpoint.replace(".", "\\.")}"`),
      );
    }
  });

  it("keeps RangeDays SQL lower bounds behind the date-window framework", () => {
    const productionFiles = [
      "repositories/activity-repository.ts",
      "repositories/body-analytics-repository.ts",
      "repositories/body-clickhouse.ts",
      "repositories/calendar-repository.ts",
      "repositories/clickhouse-activity-sensor-analytics.ts",
      "repositories/clickhouse-activity-sensor-store.ts",
      "repositories/clickhouse-sleep-repository.ts",
      "repositories/correlation-repository.ts",
      "repositories/cycling-advanced-repository.ts",
      "repositories/daily-metrics-repository.ts",
      "repositories/duration-curves-repository.ts",
      "repositories/efficiency-repository.ts",
      "repositories/hiking-repository.ts",
      "repositories/journal-repository.ts",
      "repositories/nutrition-analytics-repository.ts",
      "repositories/pmc-repository.ts",
      "repositories/power-repository.ts",
      "repositories/predictions-repository.ts",
      "repositories/running-repository.ts",
      "repositories/sleep-repository.ts",
      "repositories/stress-repository.ts",
      "repositories/strength-repository.ts",
      "repositories/training-repository.ts",
    ];

    const forbiddenPatterns = [
      /INTERVAL\s*\{\s*days\s*:\s*Int32\s*\}\s*DAY/i,
      /toIntervalDay\s*\(\s*\{\s*days\s*:\s*UInt32\s*\}\s*\)/i,
      /CURRENT_TIMESTAMP\s*-\s*\$\{[^}]*days[^}]*\}/i,
      /NOW\s*\(\s*\)\s*-\s*\$\{[^}]*days[^}]*\}/i,
    ];

    for (const productionFile of productionFiles) {
      const source = readServerSource(productionFile);
      for (const forbiddenPattern of forbiddenPatterns) {
        expect(
          source,
          `${productionFile} must use date-window.ts range predicates instead of ${forbiddenPattern}`,
        ).not.toMatch(forbiddenPattern);
      }
    }
  });
});
