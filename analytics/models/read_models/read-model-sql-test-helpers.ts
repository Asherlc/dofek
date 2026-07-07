import { readFileSync } from "node:fs";

export function readModelSql(modelFileName: string): string {
  try {
    return readFileSync(new URL(`./${modelFileName}`, import.meta.url), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read read model SQL file ${modelFileName}: ${reason}`);
  }
}

/** Extract a CTE body, skipping parentheses that appear inside single-quoted strings. */
export function extractCteSql(modelSql: string, name: string): string {
  const startMarker = `${name} AS (`;
  const startIndex = modelSql.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Could not find ${name} CTE`);
  }

  let cursorIndex = startIndex + startMarker.length;
  let parenthesisDepth = 1;

  while (cursorIndex < modelSql.length && parenthesisDepth > 0) {
    const currentChar = modelSql[cursorIndex];

    if (currentChar === "'") {
      cursorIndex += 1;
      while (cursorIndex < modelSql.length) {
        if (modelSql[cursorIndex] === "'" && modelSql[cursorIndex + 1] === "'") {
          cursorIndex += 2;
          continue;
        }
        if (modelSql[cursorIndex] === "'") {
          cursorIndex += 1;
          break;
        }
        cursorIndex += 1;
      }
      continue;
    }

    if (currentChar === "(") parenthesisDepth += 1;
    if (currentChar === ")") parenthesisDepth -= 1;
    cursorIndex += 1;
  }

  if (parenthesisDepth !== 0) {
    throw new Error(`Could not find ${name} CTE end`);
  }

  return modelSql.slice(startIndex + startMarker.length, cursorIndex - 1);
}
