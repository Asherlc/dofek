import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildPlantUml,
  extractTables,
  generateSchemaDbml,
  normalizeGeneratedDbml,
  parseColumnLine,
  parseColumns,
  parseRefs,
  parseTables,
  type Table,
} from "./generate-schema-diagram.ts";

describe("generateSchemaDbml", () => {
  it("preserves constant and composite SQL index expressions from schema metadata", () => {
    const category = pgEnum("category", ["food", "activity"]);
    const owner = pgTable("owner", { id: uuid().primaryKey() });
    const example = pgTable(
      "example",
      {
        id: uuid(),
        name: text(),
        ownerId: uuid("owner_id").references(() => owner.id),
        category: category(),
      },
      (table) => [
        uniqueIndex("single_row_idx").on(sql`(true)`),
        index("name_expression_idx").on(table.id, sql`lower(${table.name})`),
        index("name_idx").on(table.name),
      ],
    );
    const dbml = generateSchemaDbml({ category, owner, example });
    expect(dbml).toContain("(`(true)`) [name: 'single_row_idx', unique]");
    expect(dbml).toContain('("id", `lower("example"."name")`) [name: \'name_expression_idx\']');
    expect(dbml).toContain("name [name: 'name_idx']");
    expect(dbml).toContain("example.owner_id > owner.id");
    expect(dbml).toContain("    (`(true)`) [name: 'single_row_idx', unique]\n");
  });
});

describe("normalizeGeneratedDbml", () => {
  it("removes generator whitespace while preserving one final newline", () => {
    expect(normalizeGeneratedDbml("table x {  \n    \n}\n\n")).toBe("table x {\n\n}\n");
  });
});

const SINGLE_TABLE_DBML = `table fitness.activity {
  id uuid [pk, not null, default: \`gen_random_uuid()\`]
  provider_id text [not null]
  name text
  started_at "timestamp with time zone" [not null]
  raw jsonb

  indexes {
    (provider_id, external_id) [name: 'activity_provider_external_idx', unique]
  }
}`;

const MULTI_TABLE_DBML = `table fitness.provider {
  id text [pk, not null]
  name text [not null]
  user_id uuid [not null]
}

table fitness.activity {
  id uuid [pk, not null]
  provider_id text [not null]
  name text
}

ref activity_provider_id_fk: fitness.activity.provider_id > fitness.provider.id [delete: no action, update: no action]`;

const COMPOSITE_REF_DBML = `table fitness.human_record_target {
  id uuid [not null]
  identity_id uuid [not null]
  user_id uuid [not null]
}

table fitness.human_food_nutrient_decision {
  target_id uuid [not null]
  identity_id uuid [not null]
  user_id uuid [not null]
}

ref human_food_nutrient_decision_target_fk: fitness.human_food_nutrient_decision.(target_id, identity_id, user_id) > fitness.human_record_target.(id, identity_id, user_id) [delete: no action, update: no action]`;

describe("extractTables", () => {
  it("extracts a single table", () => {
    const tables = extractTables(SINGLE_TABLE_DBML);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("activity");
    expect(tables[0].body).toContain("id uuid");
    expect(tables[0].body).toContain("indexes");
  });

  it("extracts multiple tables", () => {
    const tables = extractTables(MULTI_TABLE_DBML);
    expect(tables).toHaveLength(2);
    expect(tables[0].name).toBe("provider");
    expect(tables[1].name).toBe("activity");
  });

  it("returns empty array for input with no tables", () => {
    expect(extractTables("ref foo: fitness.a.b > fitness.c.d")).toEqual([]);
    expect(extractTables("")).toEqual([]);
  });

  it("handles nested braces in indexes block", () => {
    const dbml = `table fitness.test {
  id uuid [pk]

  indexes {
    id [name: 'test_idx']
  }
}`;
    const tables = extractTables(dbml);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("test");
  });
});

describe("parseColumnLine", () => {
  it("parses a simple column", () => {
    const col = parseColumnLine("  name text");
    expect(col).toEqual({ name: "name", type: "text", pk: false, fk: false });
  });

  it("parses a PK column with attributes", () => {
    const col = parseColumnLine("  id uuid [pk, not null, default: `gen_random_uuid()`]");
    expect(col).toEqual({ name: "id", type: "uuid", pk: true, fk: false });
  });

  it("simplifies timestamp types", () => {
    const col = parseColumnLine('  started_at "timestamp with time zone" [not null]');
    expect(col).toEqual({ name: "started_at", type: "timestamp", pk: false, fk: false });
  });

  it("converts text[] to text_array", () => {
    const col = parseColumnLine("  groups text[]");
    expect(col).toEqual({ name: "groups", type: "text_array", pk: false, fk: false });
  });

  it("converts text[] with attributes to text_array", () => {
    const col = parseColumnLine("  scopes text[] [not null]");
    expect(col).toEqual({ name: "scopes", type: "text_array", pk: false, fk: false });
  });

  it("returns null for empty lines", () => {
    expect(parseColumnLine("")).toBeNull();
    expect(parseColumnLine("   ")).toBeNull();
  });

  it("returns null for closing brace", () => {
    expect(parseColumnLine("}")).toBeNull();
  });

  it("matches indexes line as a column (stripped by parseColumns before reaching here)", () => {
    // The regex matches "indexes {" — this is fine because parseColumns
    // strips indexes blocks before calling parseColumnLine
    const col = parseColumnLine("indexes {");
    expect(col).not.toBeNull();
  });

  it("strips quotes from types", () => {
    const col = parseColumnLine('  expires_at "timestamp with time zone" [not null]');
    expect(col?.type).toBe("timestamp");
  });
});

describe("parseColumns", () => {
  it("parses columns and strips indexes block", () => {
    const body = `
  id uuid [pk, not null]
  name text [not null]
  groups text[]

  indexes {
    (id, name) [name: 'test_idx', unique]
  }
`;
    const columns = parseColumns(body);
    expect(columns).toHaveLength(3);
    expect(columns[0]).toEqual({ name: "id", type: "uuid", pk: true, fk: false });
    expect(columns[1]).toEqual({ name: "name", type: "text", pk: false, fk: false });
    expect(columns[2]).toEqual({ name: "groups", type: "text_array", pk: false, fk: false });
  });

  it("handles body with no indexes", () => {
    const body = `
  id uuid [pk]
  value text
`;
    const columns = parseColumns(body);
    expect(columns).toHaveLength(2);
  });

  it("handles empty body", () => {
    expect(parseColumns("")).toEqual([]);
  });
});

describe("parseTables", () => {
  it("parses tables from DBML", () => {
    const tables = parseTables(SINGLE_TABLE_DBML);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("activity");
    expect(tables[0].columns).toHaveLength(5);
    expect(tables[0].columns[0]).toEqual({ name: "id", type: "uuid", pk: true, fk: false });
    expect(tables[0].columns[3]).toEqual({
      name: "started_at",
      type: "timestamp",
      pk: false,
      fk: false,
    });
  });
});

describe("parseRefs", () => {
  it("parses refs and marks FK columns", () => {
    const tables = parseTables(MULTI_TABLE_DBML);
    const refs = parseRefs(MULTI_TABLE_DBML, tables);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      fromTable: "activity",
      fromCols: ["provider_id"],
      toTable: "provider",
      toCols: ["id"],
    });

    const activityTable = tables.find((t) => t.name === "activity");
    const providerIdCol = activityTable?.columns.find((c) => c.name === "provider_id");
    expect(providerIdCol?.fk).toBe(true);
  });

  it("returns empty array when no refs exist", () => {
    const tables = parseTables(SINGLE_TABLE_DBML);
    const refs = parseRefs(SINGLE_TABLE_DBML, tables);
    expect(refs).toEqual([]);
  });

  it("does not crash when ref references a table not in the list", () => {
    const dbml =
      "ref foo: fitness.missing.col > fitness.also_missing.col [delete: no action, update: no action]";
    const refs = parseRefs(dbml, []);
    expect(refs).toHaveLength(1);
  });

  it("parses composite refs and marks every source column as an FK", () => {
    const tables = parseTables(COMPOSITE_REF_DBML);
    const refs = parseRefs(COMPOSITE_REF_DBML, tables);

    expect(refs).toEqual([
      {
        fromTable: "human_food_nutrient_decision",
        fromCols: ["target_id", "identity_id", "user_id"],
        toTable: "human_record_target",
        toCols: ["id", "identity_id", "user_id"],
      },
    ]);
    expect(
      tables
        .find((table) => table.name === "human_food_nutrient_decision")
        ?.columns.filter((column) => column.fk)
        .map((column) => column.name),
    ).toEqual(["target_id", "identity_id", "user_id"]);
    expect(buildPlantUml(tables, refs)).toContain(
      "human_record_target ||--o{ human_food_nutrient_decision",
    );
  });
});

describe("buildPlantUml", () => {
  it("generates valid PlantUML with PK/FK markers", () => {
    const tables: Table[] = [
      {
        name: "provider",
        columns: [{ name: "id", type: "text", pk: true, fk: false }],
      },
      {
        name: "activity",
        columns: [
          { name: "id", type: "uuid", pk: true, fk: false },
          { name: "provider_id", type: "text", pk: false, fk: true },
          { name: "name", type: "text", pk: false, fk: false },
        ],
      },
    ];
    const refs = [
      { fromTable: "activity", fromCols: ["provider_id"], toTable: "provider", toCols: ["id"] },
    ];

    const puml = buildPlantUml(tables, refs);

    expect(puml).toContain("@startuml schema");
    expect(puml).toContain("@enduml");
    expect(puml).toContain('entity "provider" {');
    expect(puml).toContain("  * id : text <<PK>>");
    expect(puml).toContain('entity "activity" {');
    expect(puml).toContain("  * id : uuid <<PK>>");
    expect(puml).toContain("  --");
    expect(puml).toContain("  provider_id : text <<FK>>");
    expect(puml).toContain("  name : text");
    expect(puml).toContain("provider ||--o{ activity");
  });

  it("omits separator when table has no non-PK columns", () => {
    const tables: Table[] = [
      {
        name: "simple",
        columns: [{ name: "id", type: "uuid", pk: true, fk: false }],
      },
    ];
    const puml = buildPlantUml(tables, []);
    expect(puml).not.toContain("  --");
  });

  it("omits separator when table has no PK columns", () => {
    const tables: Table[] = [
      {
        name: "no_pk",
        columns: [{ name: "value", type: "text", pk: false, fk: false }],
      },
    ];
    const puml = buildPlantUml(tables, []);
    expect(puml).not.toContain("  --");
    expect(puml).not.toContain("<<PK>>");
  });

  it("handles empty tables and refs", () => {
    const puml = buildPlantUml([], []);
    expect(puml).toContain("@startuml schema");
    expect(puml).toContain("@enduml");
  });
});
