import { describe, expect, it } from "vitest";
import {
  makeTrainingChartAvailability,
  trainingChartAvailabilitySchema,
} from "./training-chart-availability.ts";

describe("training chart availability", () => {
  it("describes an unavailable chart using the source, counts, and server-authored message", () => {
    const result = makeTrainingChartAvailability({
      sourceLabel: "Running activity sensor summaries",
      observedCount: 0,
      minimumCount: 1,
      message:
        "No running pace data is available from Running activity sensor summaries. Record at least 1 running activity with pace data to show this chart.",
    });

    expect(result).toEqual({
      status: "insufficient_data",
      sourceLabel: "Running activity sensor summaries",
      observedCount: 0,
      minimumCount: 1,
      message:
        "No running pace data is available from Running activity sensor summaries. Record at least 1 running activity with pace data to show this chart.",
    });
    expect(trainingChartAvailabilitySchema.parse(result)).toEqual(result);
  });

  it("marks a chart available once the server has enough observations", () => {
    const result = makeTrainingChartAvailability({
      sourceLabel: "Running activity sensor summaries",
      observedCount: 2,
      minimumCount: 1,
      message: "Running pace data is available from Running activity sensor summaries.",
    });

    expect(result.status).toBe("available");
    expect(result.observedCount).toBe(2);
  });
});
