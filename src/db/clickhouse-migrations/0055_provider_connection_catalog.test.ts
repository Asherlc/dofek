import { describe, expect, it } from "vitest";
import { createMigration } from "./0055_provider_connection_catalog.ts";

describe("0055_provider_connection_catalog", () => {
  it("rebuilds the provider catalog and creates the connection mirror", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0055_provider_connection_catalog");
    expect(migration.statements).toEqual([
      expect.stringContaining("user_id Nullable(UUID)"),
      expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection"),
    ]);
    expect(migration.run).toEqual(expect.any(Function));
  });
});
