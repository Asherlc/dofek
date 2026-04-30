import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";

const sqlFileCache = new Map<string, SQL>();
const sqlFileTextCache = new Map<string, string>();

export function sqlFile(relativePath: string, moduleUrl: string): SQL {
  const filePath = resolveSqlFilePath(relativePath, moduleUrl);
  const cachedSql = sqlFileCache.get(filePath);
  if (cachedSql) return cachedSql;

  const loadedSql = sql.raw(readSqlFile(filePath));
  sqlFileCache.set(filePath, loadedSql);
  return loadedSql;
}

export function sqlFileTemplate(
  relativePath: string,
  moduleUrl: string,
): (values: Record<string, SQL>) => SQL {
  const filePath = resolveSqlFilePath(relativePath, moduleUrl);
  const template = readSqlFile(filePath);

  return (values: Record<string, SQL>) => {
    const chunks: SQL[] = [];
    let previousIndex = 0;
    const placeholderPattern = /\{\{([a-z][a-zA-Z0-9]*)\}\}/g;

    for (const match of template.matchAll(placeholderPattern)) {
      if (match.index == null) {
        throw new Error(`SQL template placeholder in ${filePath} is missing an index`);
      }

      const placeholderName = match[1];
      if (placeholderName == null) {
        throw new Error(`SQL template placeholder in ${filePath} is missing a name`);
      }

      const replacement = values[placeholderName];
      if (replacement == null) {
        throw new Error(`Missing SQL template value: ${placeholderName}`);
      }

      chunks.push(sql.raw(template.slice(previousIndex, match.index)));
      chunks.push(replacement);
      previousIndex = match.index + match[0].length;
    }

    chunks.push(sql.raw(template.slice(previousIndex)));
    return sql.join(chunks, sql``);
  };
}

function resolveSqlFilePath(relativePath: string, moduleUrl: string): string {
  return fileURLToPath(new URL(relativePath, moduleUrl));
}

function readSqlFile(filePath: string): string {
  const cachedText = sqlFileTextCache.get(filePath);
  if (cachedText != null) return cachedText;

  const loadedText = readFileSync(filePath, "utf-8");
  sqlFileTextCache.set(filePath, loadedText);
  return loadedText;
}
