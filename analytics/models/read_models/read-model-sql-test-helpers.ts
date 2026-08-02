import { readFileSync } from "node:fs";

export function readModelSql(modelFileName: string): string {
  try {
    return readFileSync(new URL(`./${modelFileName}`, import.meta.url), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read read model SQL file ${modelFileName}: ${reason}`);
  }
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

export function renderDbtModelSql(
  modelSql: string,
  options: { isIncremental: boolean },
): string {
  return modelSql
    .replace(/\{%\s*set[\s\S]*?%\}\s*/g, "")
    .replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}\s*/g, "")
    .trimStart()
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (
        _match: string,
        incrementalSql: string,
        nonIncrementalSql: string | undefined,
      ) => (options.isIncremental ? incrementalSql : (nonIncrementalSql ?? "")),
    );
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

function isSqlIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function skipWhitespace(sql: string, startIndex: number): number {
  let cursorIndex = startIndex;
  while (cursorIndex < sql.length && /\s/.test(sql[cursorIndex] ?? "")) {
    cursorIndex += 1;
  }
  return cursorIndex;
}

function skipSqlTrivia(sql: string, startIndex: number): number {
  let cursorIndex = startIndex;
  let nextIndex = skipWhitespace(sql, cursorIndex);

  while (nextIndex !== cursorIndex) {
    cursorIndex = nextIndex;
    if (sql[cursorIndex] === "-" && sql[cursorIndex + 1] === "-") {
      cursorIndex = skipSqlLineComment(sql, cursorIndex);
      nextIndex = skipWhitespace(sql, cursorIndex);
      continue;
    }
    if (sql[cursorIndex] === "/" && sql[cursorIndex + 1] === "*") {
      cursorIndex = skipSqlBlockComment(sql, cursorIndex);
      nextIndex = skipWhitespace(sql, cursorIndex);
      continue;
    }
    nextIndex = cursorIndex;
  }

  if (sql[cursorIndex] === "-" && sql[cursorIndex + 1] === "-") {
    return skipSqlTrivia(sql, skipSqlLineComment(sql, cursorIndex));
  }
  if (sql[cursorIndex] === "/" && sql[cursorIndex + 1] === "*") {
    return skipSqlTrivia(sql, skipSqlBlockComment(sql, cursorIndex));
  }

  return cursorIndex;
}

function matchCteHeaderEndIndex(sql: string, name: string, startIndex: number): number | null {
  if (isSqlIdentifierChar(sql[startIndex - 1])) {
    return null;
  }

  const nameEndIndex = startIndex + name.length;
  if (sql.slice(startIndex, nameEndIndex).toLowerCase() !== name.toLowerCase()) {
    return null;
  }
  if (isSqlIdentifierChar(sql[nameEndIndex])) {
    return null;
  }

  let cursorIndex = skipSqlTrivia(sql, nameEndIndex);
  if (sql.slice(cursorIndex, cursorIndex + 2).toLowerCase() !== "as") {
    return null;
  }
  cursorIndex += 2;
  if (isSqlIdentifierChar(sql[cursorIndex])) {
    return null;
  }

  cursorIndex = skipSqlTrivia(sql, cursorIndex);
  const materializedEndIndex = cursorIndex + "materialized".length;
  if (
    sql.slice(cursorIndex, materializedEndIndex).toLowerCase() === "materialized" &&
    !isSqlIdentifierChar(sql[materializedEndIndex])
  ) {
    cursorIndex = skipSqlTrivia(sql, materializedEndIndex);
  }
  return sql[cursorIndex] === "(" ? cursorIndex + 1 : null;
}

function findCteBodyStartIndex(modelSql: string, name: string): number | null {
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

    const headerEndIndex = matchCteHeaderEndIndex(modelSql, name, cursorIndex);
    if (headerEndIndex !== null) {
      return headerEndIndex;
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
