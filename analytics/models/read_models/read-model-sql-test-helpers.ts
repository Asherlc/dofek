import { readFileSync } from "node:fs";

export function readModelSql(modelFileName: string): string {
  try {
    return readFileSync(new URL(`./${modelFileName}`, import.meta.url), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read read model SQL file ${modelFileName}: ${reason}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skipSqlLineComment(sql: string, startIndex: number): number {
  let cursorIndex = startIndex + 2;
  while (cursorIndex < sql.length && sql[cursorIndex] !== "\n") {
    cursorIndex += 1;
  }
  return cursorIndex;
}

function skipSqlBlockComment(sql: string, startIndex: number): number {
  let cursorIndex = startIndex + 2;
  while (cursorIndex < sql.length - 1) {
    if (sql[cursorIndex] === "*" && sql[cursorIndex + 1] === "/") {
      return cursorIndex + 2;
    }
    cursorIndex += 1;
  }
  return sql.length;
}

function skipSqlStringLiteral(sql: string, startIndex: number): number {
  let cursorIndex = startIndex + 1;
  while (cursorIndex < sql.length) {
    if (sql[cursorIndex] === "'" && sql[cursorIndex + 1] === "'") {
      cursorIndex += 2;
      continue;
    }
    if (sql[cursorIndex] === "'") {
      return cursorIndex + 1;
    }
    cursorIndex += 1;
  }
  return sql.length;
}

function findCteBodyStartIndex(modelSql: string, name: string): number | null {
  const startPattern = new RegExp(`\\b${escapeRegExp(name)}\\s+AS\\s*\\(`, "iy");
  let cursorIndex = 0;

  while (cursorIndex < modelSql.length) {
    const currentChar = modelSql[cursorIndex];
    const nextChar = modelSql[cursorIndex + 1];

    if (currentChar === "-" && nextChar === "-") {
      cursorIndex = skipSqlLineComment(modelSql, cursorIndex);
      continue;
    }

    if (currentChar === "/" && nextChar === "*") {
      cursorIndex = skipSqlBlockComment(modelSql, cursorIndex);
      continue;
    }

    if (currentChar === "'") {
      cursorIndex = skipSqlStringLiteral(modelSql, cursorIndex);
      continue;
    }

    startPattern.lastIndex = cursorIndex;
    const startMatch = startPattern.exec(modelSql);
    if (startMatch) {
      return startMatch.index + startMatch[0].length;
    }

    cursorIndex += 1;
  }

  return null;
}

/** Extract a CTE body, skipping parentheses inside quotes and SQL comments. */
export function extractCteSql(modelSql: string, name: string): string {
  const bodyStartIndex = findCteBodyStartIndex(modelSql, name);
  if (bodyStartIndex === null) {
    throw new Error(`Could not find ${name} CTE`);
  }

  let cursorIndex = bodyStartIndex;
  let parenthesisDepth = 1;

  while (cursorIndex < modelSql.length && parenthesisDepth > 0) {
    const currentChar = modelSql[cursorIndex];
    const nextChar = modelSql[cursorIndex + 1];

    if (currentChar === "-" && nextChar === "-") {
      cursorIndex = skipSqlLineComment(modelSql, cursorIndex);
      continue;
    }

    if (currentChar === "/" && nextChar === "*") {
      cursorIndex = skipSqlBlockComment(modelSql, cursorIndex);
      continue;
    }

    if (currentChar === "'") {
      cursorIndex = skipSqlStringLiteral(modelSql, cursorIndex);
      continue;
    }

    if (currentChar === "(") parenthesisDepth += 1;
    if (currentChar === ")") parenthesisDepth -= 1;
    cursorIndex += 1;
  }

  if (parenthesisDepth !== 0) {
    throw new Error(`Could not find ${name} CTE end`);
  }

  return modelSql.slice(bodyStartIndex, cursorIndex - 1);
}
