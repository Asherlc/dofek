import { describe, expect, it } from "vitest";
import { createMigration } from "./0065_sleep_staging_available.ts";

describe("0065_sleep_staging_available", () => {
  it("adds the flag to source and serving tables before recreating the sleep view", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0065_sleep_staging_available");
    expect(migration.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "postgres_fitness.sleep_session ADD COLUMN IF NOT EXISTS staging_available Bool",
        ),
        expect.stringContaining(
          "analytics.daily_sleep ADD COLUMN IF NOT EXISTS staging_available Bool",
        ),
        expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_sleep"),
      ]),
    );
  });
});
