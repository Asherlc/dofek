import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pgGenerate } from "drizzle-dbml-generator";
import plantumlEncoder from "plantuml-encoder";
import * as schema from "../src/db/schema.ts";

const dbmlPath = "docs/schema.dbml";
const pumlPath = "docs/schema.puml";

// Generate DBML from Drizzle schema (also writes the .dbml file)
pgGenerate({ schema, out: dbmlPath, relational: false });
const dbml = readFileSync(dbmlPath, "utf-8");

// Extract table blocks by tracking brace depth
function extractTables(input: string): Array<{ name: string; body: string }> {
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

// Parse tables from DBML
const tables: Array<{
  name: string;
  columns: Array<{ name: string; type: string; pk: boolean; fk: boolean }>;
}> = [];
for (const { name: tableName, body } of extractTables(dbml)) {
  const columns: Array<{ name: string; type: string; pk: boolean; fk: boolean }> = [];

  // Strip indexes blocks before parsing columns
  const columnsSection = body.replace(/indexes\s*\{[^}]*\}/gs, "");

  for (const line of columnsSection.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "}") continue;

    const colMatch = trimmed.match(/^(\w+)\s+(.+?)(?:\s*\[(.+)])?$/);
    if (colMatch) {
      const colName = colMatch[1];
      const rawType = colMatch[2].replace(/"/g, "");
      const attrs = colMatch[3] ?? "";
      const pk = attrs.includes("pk");

      // Simplify types for readability
      let type = rawType;
      if (type.includes("timestamp")) type = "timestamp";
      if (type === "text[]") type = "text_array";

      columns.push({ name: colName, type, pk, fk: false });
    }
  }
  tables.push({ name: tableName, columns });
}

// Parse refs from DBML
interface Ref {
  fromTable: string;
  fromCol: string;
  toTable: string;
  toCol: string;
}
const refs: Ref[] = [];
const refRegex = /ref\s+\w+:\s+fitness\.(\w+)\.(\w+)\s*>\s*fitness\.(\w+)\.(\w+)/g;
for (const match of dbml.matchAll(refRegex)) {
  refs.push({ fromTable: match[1], fromCol: match[2], toTable: match[3], toCol: match[4] });

  // Mark FK columns
  const table = tables.find((t) => t.name === match[1]);
  const col = table?.columns.find((c) => c.name === match[2]);
  if (col) col.fk = true;
}

// Build PlantUML ERD
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

// Add relationships
for (const ref of refs) {
  lines.push(`${ref.toTable} ||--o{ ${ref.fromTable}`);
}

lines.push("");
lines.push("@enduml");

const puml = lines.join("\n");
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
