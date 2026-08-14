import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const clickHouseSqlTemplateCache = new Map<string, string>();

export function loadClickHouseSql(
  fileName: string,
  replacements: Record<string, string> = {},
): string {
  let template = clickHouseSqlTemplateCache.get(fileName);
  if (!template) {
    const templatePath = fileURLToPath(new URL(`./clickhouse-sql/${fileName}`, import.meta.url));
    template = readFileSync(templatePath, "utf8");
    clickHouseSqlTemplateCache.set(fileName, template);
  }

  let query = template;
  for (const [key, value] of Object.entries(replacements)) {
    query = query.replaceAll(new RegExp(`{{\\s*${key}\\s*}}`, "g"), value);
  }

  const missingReplacement = query.match(/{{\s*[A-Za-z0-9_]+\s*}}/);
  if (missingReplacement) {
    throw new Error(`Missing ClickHouse SQL replacement for ${missingReplacement[0]}`);
  }

  return query.trim();
}
