import { describe, expect, it } from "vitest";
import {
  buildPlantUml,
  type Column,
  extractTables,
  parseColumnLine,
  parseColumns,
  parseRefs,
  parseTables,
  type Table,
} from "./generate-schema-diagram.ts";

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
      fromCol: "provider_id",
      toTable: "provider",
      toCol: "id",
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
      { fromTable: "activity", fromCol: "provider_id", toTable: "provider", toCol: "id" },
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
