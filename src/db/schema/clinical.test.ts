import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { clinicalRecord } from "./clinical.ts";

describe("clinicalRecord", () => {
  it("defines the canonical account-scoped FHIR record contract", () => {
    const config = getTableConfig(clinicalRecord);

    expect(config.schema).toBe("fitness");
    expect(config.name).toBe("clinical_record");
    expect(
      config.columns.map((column) => ({
        hasDefault: column.hasDefault,
        name: column.name,
        notNull: column.notNull,
      })),
    ).toEqual([
      { hasDefault: true, name: "id", notNull: true },
      { hasDefault: false, name: "user_id", notNull: true },
      { hasDefault: false, name: "provider_id", notNull: true },
      { hasDefault: false, name: "external_id", notNull: true },
      { hasDefault: false, name: "clinical_type", notNull: true },
      { hasDefault: false, name: "display_name", notNull: true },
      { hasDefault: false, name: "source_name", notNull: false },
      { hasDefault: false, name: "fhir_version", notNull: true },
      { hasDefault: false, name: "fhir", notNull: true },
      { hasDefault: false, name: "downloaded_at", notNull: true },
      { hasDefault: false, name: "recorded_at", notNull: false },
      { hasDefault: false, name: "issued_at", notNull: false },
    ]);
    expect(
      config.indexes.map((indexBuilder) => ({
        columns: indexBuilder.config.columns.map((column) =>
          "name" in column ? column.name : null,
        ),
        name: indexBuilder.config.name,
        unique: indexBuilder.config.unique,
      })),
    ).toContainEqual({
      columns: ["user_id", "provider_id", "external_id"],
      name: "clinical_record_user_provider_external_idx",
      unique: true,
    });
  });
});
