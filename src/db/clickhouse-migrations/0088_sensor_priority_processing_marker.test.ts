import { describe, expect, it } from "vitest";
import { createMigration } from "./0088_sensor_priority_processing_marker.ts";

describe("0088_sensor_priority_processing_marker", () => {
  it("creates the sensor-priority flow's dedicated pre-CDC marker destination", () => {
    expect(createMigration()).toEqual({
      id: "0088_sensor_priority_processing_marker",
      phase: "pre-cdc",
      statements: [
        expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS postgres_fitness.processing_flow_marker_sensor_priority",
        ),
      ],
    });
  });
});
