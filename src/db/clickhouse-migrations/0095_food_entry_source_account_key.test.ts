import { describe, expect, it } from "vitest";
import { createMigration } from "./0095_food_entry_source_account_key.ts";

describe("0095_food_entry_source_account_key", () => {
  it("adds the source-account namespace before CDC starts", () => {
    expect(createMigration()).toEqual({
      id: "0095_food_entry_source_account_key",
      phase: "pre-cdc",
      statements: [
        "ALTER TABLE postgres_fitness.food_entry ADD COLUMN IF NOT EXISTS source_account_key Nullable(String)",
      ],
    });
  });
});
