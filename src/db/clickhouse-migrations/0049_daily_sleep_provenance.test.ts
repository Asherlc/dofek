import { describe, expect, it } from "vitest";
import { createMigration } from "./0049_daily_sleep_provenance.ts";

describe("0049_daily_sleep_provenance", () => {
  it("adds source provenance to the stored daily sleep model", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0049_daily_sleep_provenance");
    expect(migration.statements).toEqual([
      expect.stringContaining("source_name Nullable(String)"),
      expect.stringContaining("source_providers Array(String) DEFAULT []"),
    ]);
  });
});
