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

/** Extract a CTE body, skipping parentheses inside quotes and SQL comments. */
export function extractCteSql(modelSql: string, name: string): string {
  const startPattern = new RegExp(`\\b${escapeRegExp(name)}\\s+AS\\s*\\(`, "i");
  const startMatch = startPattern.exec(modelSql);
  if (!startMatch) {
    throw new Error(`Could not find ${name} CTE`);
  }

  const bodyStartIndex = startMatch.index + startMatch[0].length;
  let cursorIndex = bodyStartIndex;
  let parenthesisDepth = 1;

  while (cursorIndex < modelSql.length && parenthesisDepth > 0) {
    const currentChar = modelSql[cursorIndex];
    const nextChar = modelSql[cursorIndex + 1];

    if (currentChar === "-" && nextChar === "-") {
      cursorIndex += 2;
      while (cursorIndex < modelSql.length && modelSql[cursorIndex] !== "\n") {
        cursorIndex += 1;
      }
      continue;
    }

    if (currentChar === "/" && nextChar === "*") {
      cursorIndex += 2;
      while (cursorIndex < modelSql.length - 1) {
        if (modelSql[cursorIndex] === "*" && modelSql[cursorIndex + 1] === "/") {
          cursorIndex += 2;
          break;
        }
        cursorIndex += 1;
      }
      continue;
    }

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

  return modelSql.slice(bodyStartIndex, cursorIndex - 1);
}
