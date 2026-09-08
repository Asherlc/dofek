import { describe, expect, it } from "vitest";
import { createMigration } from "./0078_sensor_provider_priority_type.ts";

describe("0078_sensor_provider_priority_type", () => {
  it("aligns both dbt sensor target tables with the Int32 source priority type", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0078_sensor_provider_priority_type");
    expect(migration.statements).toEqual([
      expect.stringContaining(
        "ALTER TABLE analytics.sensor_scalar_sample MODIFY COLUMN IF EXISTS provider_priority Int32",
      ),
      expect.stringContaining(
        "ALTER TABLE analytics.deduped_sensor MODIFY COLUMN IF EXISTS provider_priority Int32",
      ),
    ]);
  });
});
