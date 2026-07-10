import { describe, expect, it } from "vitest";
import { createMigration } from "./0044_materialize_body_measurement_view.ts";

describe("0044_materialize_body_measurement_view", () => {
  it("drops and recreates the body measurement read model in one migration", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0044_materialize_body_measurement_view");
    expect(migration.statements).toHaveLength(3);
    expect(migration.statements[0]).toBe("DROP VIEW IF EXISTS analytics.v_body_measurement");
    expect(migration.statements[1]).toBe("DROP TABLE IF EXISTS analytics.v_body_measurement");
    expect(migration.statements[2]).toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_body_measurement",
    );
    expect(migration.statements[2]).toContain("REFRESH EVERY 15 MINUTE");
  });
});
