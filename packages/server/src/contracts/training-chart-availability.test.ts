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
      messages: {
        available: "Running pace data is available from Running activity sensor summaries.",
        insufficientData:
          "No running pace data is available from Running activity sensor summaries. Record at least 1 running activity with pace data to show this chart.",
      },
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
      messages: {
        available: "Running pace data is available from Running activity sensor summaries.",
        insufficientData:
          "No running pace data is available from Running activity sensor summaries. Record at least 1 running activity with pace data to show this chart.",
      },
    });

    expect(result.status).toBe("available");
    expect(result.observedCount).toBe(2);
    expect(result.message).toBe(
      "Running pace data is available from Running activity sensor summaries.",
    );
  });

  it("selects the message using the same threshold as the status", () => {
    const result = makeTrainingChartAvailability({
      sourceLabel: "Daily strain model",
      observedCount: 1,
      minimumCount: 2,
      messages: {
        available: "Daily strain trend is available.",
        insufficientData: "Record at least 2 training days to show this chart.",
      },
    });

    expect(result).toMatchObject({
      status: "insufficient_data",
      message: "Record at least 2 training days to show this chart.",
    });
  });
});
