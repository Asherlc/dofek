import { describe, expect, it } from "vitest";
import { buildWorkloadRatioResult, workloadRatioResultSchema } from "./workload-ratio.ts";

describe("buildWorkloadRatioResult", () => {
  it("returns a neutral server-owned definition with the descriptive ratio", () => {
    const result = buildWorkloadRatioResult([
      {
        date: "2026-03-28",
        dailyLoad: 100,
        strain: 12.8,
        acuteLoad: 700,
        chronicLoad: 350,
        workloadRatio: 2,
      },
    ]);

    expect(result.context).toEqual({
      label: "Recent-to-baseline workload ratio",
      description:
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
      recentDays: 7,
      baselineDays: 28,
    });
    expect(result.timeSeries[0]?.workloadRatio).toBe(2);
  });

  it("uses the latest row for the displayed strain", () => {
    const result = buildWorkloadRatioResult([
      {
        date: "2026-03-27",
        dailyLoad: 100,
        strain: 12.8,
        acuteLoad: 700,
        chronicLoad: 350,
        workloadRatio: 2,
      },
      {
        date: "2026-03-28",
        dailyLoad: 0,
        strain: 0,
        acuteLoad: 600,
        chronicLoad: 350,
        workloadRatio: 1.71,
      },
    ]);

    expect(result.displayedStrain).toBe(0);
    expect(result.displayedDate).toBe("2026-03-28");
  });

  it("does not share mutable context between results", () => {
    const first = buildWorkloadRatioResult([]);
    const second = buildWorkloadRatioResult([]);

    first.context.label = "Changed by a caller";

    expect(second.context.label).toBe("Recent-to-baseline workload ratio");
    expect(first.context).not.toBe(second.context);
  });

  it("rejects results without the required context", () => {
    const parsed = workloadRatioResultSchema.safeParse({
      timeSeries: [],
      displayedStrain: 0,
      displayedDate: null,
    });

    expect(parsed.success).toBe(false);
  });
});
