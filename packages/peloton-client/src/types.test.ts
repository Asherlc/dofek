import { describe, expect, it } from "vitest";
import { pelotonPerformanceGraphSchema } from "./types.ts";

describe("pelotonPerformanceGraphSchema", () => {
  it.each([
    { average_value: null, max_value: 140 },
    { average_value: 130, max_value: null },
    { average_value: null, max_value: null },
  ])("preserves missing metric summaries: %j", (summaries) => {
    const graph = pelotonPerformanceGraphSchema.parse({
      duration: 20,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Heart Rate",
          slug: "heart_rate",
          values: [null, 120, null, 140],
          ...summaries,
        },
      ],
    });

    expect(graph.metrics[0]).toEqual({
      display_name: "Heart Rate",
      slug: "heart_rate",
      values: [null, 120, null, 140],
      ...summaries,
    });
  });
});
