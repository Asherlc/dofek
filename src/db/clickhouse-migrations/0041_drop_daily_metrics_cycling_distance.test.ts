import { describe, expect, it } from "vitest";
import { createMigration } from "./0041_drop_daily_metrics_cycling_distance.ts";

describe("0041_drop_daily_metrics_cycling_distance", () => {
  it("drops the obsolete mirrored daily cycling distance column", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0041_drop_daily_metrics_cycling_distance");
    expect(migration.statements).toEqual([
      "ALTER TABLE postgres_fitness.daily_metrics DROP COLUMN IF EXISTS cycling_distance_km",
    ]);
  });
});
