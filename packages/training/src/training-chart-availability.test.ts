import { describe, expect, it } from "vitest";
import { trainingChartAvailabilitySchema } from "./training-chart-availability.ts";

const availability = {
  status: "available",
  sourceLabel: "Running",
  observedCount: 1,
  minimumCount: 1,
  message: "Available",
};
describe("shared chart availability", () => {
  it.each(["available", "insufficient_data"])("accepts %s status", (status) => {
    expect(trainingChartAvailabilitySchema.parse({ ...availability, status })).toEqual({
      ...availability,
      status,
    });
  });
  it.each([
    { status: "bad" },
    { sourceLabel: "" },
    { message: "" },
    { observedCount: -1 },
    { observedCount: 0.5 },
    { minimumCount: 0 },
    { minimumCount: 1.5 },
  ])("rejects invalid fields %j", (fields) => {
    expect(trainingChartAvailabilitySchema.safeParse({ ...availability, ...fields }).success).toBe(
      false,
    );
  });
});
