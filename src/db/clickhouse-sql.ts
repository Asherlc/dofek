import { readFileSync } from "node:fs";

export function loadClickHouseSql(
  fileName: string,
  replacements: Record<string, string> = {},
): string {
  let query = readFileSync(new URL(`./clickhouse-sql/${fileName}`, import.meta.url), "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    query = query.replaceAll(new RegExp(`{{\\s*${key}\\s*}}`, "g"), value);
  }

  const missingReplacement = query.match(/{{\s*[A-Za-z0-9_]+\s*}}/);
  if (missingReplacement) {
    throw new Error(`Missing ClickHouse SQL replacement for ${missingReplacement[0]}`);
  }

  return query.trim();
}
