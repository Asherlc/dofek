import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pgGenerate } from "drizzle-dbml-generator";
import plantumlEncoder from "plantuml-encoder";
import * as schema from "../src/db/schema.ts";

const dbmlPath = "docs/schema.dbml";
const pumlPath = "docs/schema.puml";

export interface Column {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
}

export interface Ref {
  fromTable: string;
  fromCol: string;
  toTable: string;
  toCol: string;
}

/** Extract table blocks from DBML by tracking brace depth */
export function extractTables(input: string): Array<{ name: string; body: string }> {
  const result: Array<{ name: string; body: string }> = [];
  const tableStart = /table\s+fitness\.(\w+)\s*\{/g;
  let startMatch = tableStart.exec(input);
  while (startMatch !== null) {
    const name = startMatch[1];
    let depth = 1;
    let i = startMatch.index + startMatch[0].length;
    while (i < input.length && depth > 0) {
      if (input[i] === "{") depth++;
      if (input[i] === "}") depth--;
      i++;
    }
    result.push({ name, body: input.slice(startMatch.index + startMatch[0].length, i - 1) });
    startMatch = tableStart.exec(input);
  }
  return result;
}

/** Parse a single column line from DBML into a Column object */
export function parseColumnLine(line: string): Column | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "}") return null;

  const colMatch = trimmed.match(/^(\w+)\s+(.+?)(?:\s*\[(.+)])?$/);
  if (!colMatch) return null;

  const colName = colMatch[1];
  const rawType = colMatch[2].replace(/"/g, "");
  const attrs = colMatch[3] ?? "";
  const pk = attrs.includes("pk");

  // Simplify types for readability
  let type = rawType;
  if (type.includes("timestamp")) type = "timestamp";
  if (type === "text[]") type = "text_array";

  return { name: colName, type, pk, fk: false };
}

/** Parse columns from a DBML table body (strips indexes blocks first) */
export function parseColumns(body: string): Column[] {
  const columnsSection = body.replace(/indexes\s*\{[^}]*\}/gs, "");
  const columns: Column[] = [];
  for (const line of columnsSection.split("\n")) {
    const col = parseColumnLine(line);
    if (col) columns.push(col);
  }
  return columns;
}

/** Parse all tables from DBML */
export function parseTables(dbml: string): Table[] {
  return extractTables(dbml).map(({ name, body }) => ({
    name,
    columns: parseColumns(body),
  }));
}

/** Parse refs from DBML and mark FK columns on the provided tables */
export function parseRefs(dbml: string, tables: Table[]): Ref[] {
  const refs: Ref[] = [];
  const refRegex = /ref\s+\w+:\s+fitness\.(\w+)\.(\w+)\s*>\s*fitness\.(\w+)\.(\w+)/g;
  for (const match of dbml.matchAll(refRegex)) {
    refs.push({ fromTable: match[1], fromCol: match[2], toTable: match[3], toCol: match[4] });

    // Mark FK columns
    const table = tables.find((t) => t.name === match[1]);
    const col = table?.columns.find((c) => c.name === match[2]);
    if (col) col.fk = true;
  }
  return refs;
}

/** Build PlantUML ERD string from tables and refs */
export function buildPlantUml(tables: Table[], refs: Ref[]): string {
  const lines: string[] = ["@startuml schema", "!theme plain", "skinparam linetype ortho", ""];

  for (const table of tables) {
    lines.push(`entity "${table.name}" {`);
    const pkCols = table.columns.filter((c) => c.pk);
    const otherCols = table.columns.filter((c) => !c.pk);

    for (const col of pkCols) {
      lines.push(`  * ${col.name} : ${col.type} <<PK>>`);
    }
    if (pkCols.length > 0 && otherCols.length > 0) {
      lines.push("  --");
    }
    for (const col of otherCols) {
      const fkTag = col.fk ? " <<FK>>" : "";
      lines.push(`  ${col.name} : ${col.type}${fkTag}`);
    }
    lines.push("}");
    lines.push("");
  }

  for (const ref of refs) {
    lines.push(`${ref.toTable} ||--o{ ${ref.fromTable}`);
  }

  lines.push("");
  lines.push("@enduml");

  return lines.join("\n");
}

// --- Main script execution ---
function main() {
  // Generate DBML from Drizzle schema (also writes the .dbml file)
  pgGenerate({ schema, out: dbmlPath, relational: false });
  const dbml = readFileSync(dbmlPath, "utf-8");

  const tables = parseTables(dbml);
  const refs = parseRefs(dbml, tables);
  const puml = buildPlantUml(tables, refs);

  writeFileSync(pumlPath, puml);

  console.log(`Schema diagrams generated:`);
  console.log(`  DBML:     ${dbmlPath}`);
  console.log(`  PlantUML: ${pumlPath}`);

  // Open in browser with --open flag
  if (process.argv.includes("--open")) {
    const encoded = plantumlEncoder.encode(puml);
    const url = `https://www.plantuml.com/plantuml/svg/${encoded}`;
    console.log(`\nOpening in browser...`);
    execSync(`open "${url}"`);
  }
}

// Only run when executed directly (not imported for testing)
const isDirectExecution = process.argv[1]?.endsWith("generate-schema-diagram.ts");
if (isDirectExecution) {
  main();
}
