import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelSql = readFileSync(
  new URL("./activity_sensor_summary_rows.sql", import.meta.url),
  "utf8",
);

describe("activity_sensor_summary_rows model", () => {
  describe("best_twenty_minute_power_per_activity window-sample-count clamp", () => {
    it("clamps the divisor to at least 1 so slow power cadences cannot divide by zero", () => {
      // Three call sites must use the same guarded expression, so a slow power
      // cadence (interval_seconds > 1200) cannot round the 20-minute window
      // sample count down to 0 and emit NaN from `0 / 0` or a self-match join.
      const guardedDivisorMatches =
        modelSql.match(
          /greatest\(round\(1200\.0 \/ power_sample_rate\.interval_seconds\), 1\)/g,
        ) ?? [];
      expect(guardedDivisorMatches).toHaveLength(3);
    });

    it("leaves no unguarded 20-minute window sample count expression", () => {
      const unguardedMatches =
        modelSql.match(
          /(?<!greatest\()round\(1200\.0 \/ power_sample_rate\.interval_seconds\)(?!, 1\))/g,
        ) ?? [];
      expect(unguardedMatches).toHaveLength(0);
    });

    it("keeps lifecycle columns before appended power analytics columns", () => {
      const lifecycleColumnIndex = modelSql.indexOf("toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version");
      const bestTwentyMinutePowerIndex = modelSql.indexOf(
        "best_twenty_minute_power_per_activity.best_twenty_minute_power AS best_twenty_minute_power",
      );

      expect(lifecycleColumnIndex).toBeGreaterThan(-1);
      expect(bestTwentyMinutePowerIndex).toBeGreaterThan(-1);
      expect(lifecycleColumnIndex).toBeLessThan(bestTwentyMinutePowerIndex);
    });
  });
});
