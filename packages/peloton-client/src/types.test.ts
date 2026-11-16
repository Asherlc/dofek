import { describe, expect, it } from "vitest";
import { pelotonPerformanceGraphSchema } from "./types.ts";

describe("pelotonPerformanceGraphSchema", () => {
  it.each([null, 118])("preserves summary value %j with empty metric arrays", (value) => {
    const response = {
      duration: 20,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [{ display_name: "Avg Output", slug: "avg_output", value }],
      summaries: [{ display_name: "Total Output", slug: "total_output", value }],
      metrics: ["output", "cadence", "resistance", "speed"].map((slug) => ({
        display_name: slug,
        slug,
        values: [],
        average_value: null,
        max_value: null,
      })),
    };

    expect(pelotonPerformanceGraphSchema.parse(response)).toEqual(response);
  });

  describe.each(["average_summaries", "summaries"])("%s", (summaryField) => {
    it.each([
      { value: "118" },
      { value: {} },
      { value: [] },
      { value: true },
      { value: undefined },
    ])("rejects invalid summary value %j", ({ value }) => {
      const response = {
        duration: 20,
        is_class_plan_shown: false,
        segment_list: [],
        average_summaries: [],
        summaries: [],
        metrics: [],
        [summaryField]: [{ display_name: "Output", slug: "output", value }],
      };

      expect(pelotonPerformanceGraphSchema.safeParse(response).success).toBe(false);
    });
  });

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
