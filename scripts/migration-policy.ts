import { existsSync, readFileSync, statSync } from "node:fs";

export interface MigrationPolicyViolation {
  filePath: string;
  lineNumber: number;
  ruleName: string;
  message: string;
  lineText: string;
}

interface MigrationPolicyRule {
  ruleName: string;
  pattern: RegExp;
  message: string;
}

interface SqlStatement {
  text: string;
  startLineNumber: number;
}

const riskyStatementRules: MigrationPolicyRule[] = [
  {
    ruleName: "insert-select",
    pattern: /\bINSERT\s+INTO\b[\s\S]*\bSELECT\b/i,
    message: "Deploy migrations must not run inline INSERT ... SELECT backfills.",
  },
  {
    ruleName: "materialized-view-populate",
    pattern: /\bCREATE\s+MATERIALIZED\s+VIEW\b[\s\S]*\bPOPULATE\b/i,
    message: "Deploy migrations must not populate materialized views inline.",
  },
  {
    ruleName: "clickhouse-naive-materialized-view",
    pattern: /\bCREATE\s+MATERIALIZED\s+VIEW\b/i,
    message:
      "ClickHouse read models must use dbt incremental models or insert-triggered TO-table projections, not naive materialized views.",
  },
  {
    ruleName: "system-refresh-view",
    pattern: /\bSYSTEM\s+REFRESH\s+VIEW\b/i,
    message: "Deploy migrations must not refresh ClickHouse views inline.",
  },
  {
    ruleName: "system-wait-view",
    pattern: /\bSYSTEM\s+WAIT\s+VIEW\b/i,
    message: "Deploy migrations must not wait on ClickHouse view refreshes inline.",
  },
  {
    ruleName: "refresh-every",
    pattern: /\bREFRESH\s+EVERY\b/i,
    message: "Active deploy migrations must not introduce refreshable read models.",
  },
  {
    ruleName: "clickhouse-alter-table-update",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bUPDATE\b/i,
    message: "ClickHouse mutations belong in resumable maintenance jobs, not deploy migrations.",
  },
  {
    ruleName: "clickhouse-alter-table-delete",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDELETE\b/i,
    message: "ClickHouse mutations belong in resumable maintenance jobs, not deploy migrations.",
  },
  {
    ruleName: "optimize-final",
    pattern: /\bOPTIMIZE\s+(?:TABLE\s+)?[\s\S]*\bFINAL\b/i,
    message: "Deploy migrations must not run OPTIMIZE FINAL.",
  },
];

function stripSqlComments(content: string): string {
  let output = "";
  let inBlockComment = false;
  let inSingleQuotedString = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const nextCharacter = content[index + 1] ?? "";

    if (inBlockComment) {
      if (character === "\n") {
        output += "\n";
      } else {
        output += " ";
      }
      if (character === "*" && nextCharacter === "/") {
        output += " ";
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingleQuotedString && character === "/" && nextCharacter === "*") {
      output += "  ";
      index += 1;
      inBlockComment = true;
      continue;
    }

    if (!inSingleQuotedString && character === "-" && nextCharacter === "-") {
      output += "  ";
      index += 1;
      while (index + 1 < content.length && content[index + 1] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    output += character;
    if (character === "'") {
      if (inSingleQuotedString && nextCharacter === "'") {
        output += nextCharacter;
        index += 1;
      } else {
        inSingleQuotedString = !inSingleQuotedString;
      }
    }
  }

  return output;
}

function stripSqlStrings(content: string): string {
  let output = "";
  let inSingleQuotedString = false;
  let inDoubleQuotedIdentifier = false;
  let dollarQuotedDelimiter: string | null = null;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const nextCharacter = content[index + 1] ?? "";

    if (dollarQuotedDelimiter) {
      if (character === "\n") {
        output += "\n";
      } else {
        output += " ";
      }
      if (content.startsWith(dollarQuotedDelimiter, index)) {
        output += " ".repeat(dollarQuotedDelimiter.length - 1);
        index += dollarQuotedDelimiter.length - 1;
        dollarQuotedDelimiter = null;
      }
      continue;
    }

    if (inSingleQuotedString) {
      output += character === "\n" ? "\n" : " ";
      if (character === "'") {
        if (nextCharacter === "'") {
          output += " ";
          index += 1;
        } else {
          inSingleQuotedString = false;
        }
      }
      continue;
    }

    if (inDoubleQuotedIdentifier) {
      output += character === "\n" || character === '"' ? character : " ";
      if (character === '"') {
        if (nextCharacter === '"') {
          output += " ";
          index += 1;
        } else {
          inDoubleQuotedIdentifier = false;
        }
      }
      continue;
    }

    const delimiter = readDollarQuotedDelimiter(content, index);
    if (delimiter) {
      output += " ".repeat(delimiter.length);
      index += delimiter.length - 1;
      dollarQuotedDelimiter = delimiter;
      continue;
    }

    if (character === "'") {
      output += " ";
      inSingleQuotedString = true;
      continue;
    }

    if (character === '"') {
      output += character;
      inDoubleQuotedIdentifier = true;
      continue;
    }

    output += character;
  }

  return output;
}

function splitSqlStatements(content: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let statementStart = 0;
  let startLineNumber = 1;
  let currentLineNumber = 1;
  let inSingleQuotedString = false;
  let inDoubleQuotedIdentifier = false;
  let dollarQuotedDelimiter: string | null = null;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const nextCharacter = content[index + 1] ?? "";
    if (character === "\n") {
      currentLineNumber += 1;
    }

    if (dollarQuotedDelimiter) {
      if (content.startsWith(dollarQuotedDelimiter, index)) {
        index += dollarQuotedDelimiter.length - 1;
        dollarQuotedDelimiter = null;
      }
      continue;
    }

    if (inSingleQuotedString) {
      if (character === "'") {
        if (nextCharacter === "'") {
          index += 1;
        } else {
          inSingleQuotedString = false;
        }
      }
      continue;
    }

    if (inDoubleQuotedIdentifier) {
      if (character === '"') {
        if (nextCharacter === '"') {
          index += 1;
        } else {
          inDoubleQuotedIdentifier = false;
        }
      }
      continue;
    }

    if (character === "'") {
      inSingleQuotedString = true;
      continue;
    }

    if (character === '"') {
      inDoubleQuotedIdentifier = true;
      continue;
    }

    const delimiter = readDollarQuotedDelimiter(content, index);
    if (delimiter) {
      dollarQuotedDelimiter = delimiter;
      index += delimiter.length - 1;
      continue;
    }

    if (character !== ";") {
      continue;
    }

    const rawText = content.slice(statementStart, index + 1);
    const text = rawText.trim();
    if (text) {
      statements.push({
        text,
        startLineNumber: startLineNumber + countLeadingNewlines(rawText),
      });
    }
    statementStart = index + 1;
    startLineNumber = currentLineNumber;
  }

  const rawTrailingText = content.slice(statementStart);
  const trailingText = rawTrailingText.trim();
  if (trailingText) {
    statements.push({
      text: trailingText,
      startLineNumber: startLineNumber + countLeadingNewlines(rawTrailingText),
    });
  }

  return statements;
}

function readDollarQuotedDelimiter(content: string, index: number): string | null {
  const match = content.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? null;
}

function countLeadingNewlines(value: string): number {
  const leadingWhitespace = value.match(/^\s*/)?.[0] ?? "";
  return leadingWhitespace.split("\n").length - 1;
}

function firstMeaningfulLine(statement: string): string {
  return (
    statement
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function buildViolation(
  filePath: string,
  statement: SqlStatement,
  rule: MigrationPolicyRule,
): MigrationPolicyViolation {
  return {
    filePath,
    lineNumber: statement.startLineNumber,
    ruleName: rule.ruleName,
    message: rule.message,
    lineText: firstMeaningfulLine(statement.text),
  };
}

function isUnboundedUpdate(statement: string): boolean {
  return /^\s*UPDATE\b/i.test(statement) && !/\bWHERE\b/i.test(statement);
}

function isUnboundedDelete(statement: string): boolean {
  return /^\s*DELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement);
}

function isNaiveClickHouseMaterializedView(statement: string): boolean {
  const statementWithoutStrings = stripSqlStrings(statement);
  const createMatch = statementWithoutStrings.match(/\bCREATE\s+MATERIALIZED\s+VIEW\b/i);
  if (createMatch?.index == null) {
    return false;
  }
  if (/\bREFRESH\s+EVERY\b/i.test(statementWithoutStrings)) {
    return false;
  }

  const afterCreate = statementWithoutStrings.slice(createMatch.index);
  const asMatch = afterCreate.match(/\bAS\b/i);
  if (asMatch?.index == null) {
    return false;
  }

  const header = afterCreate.slice(0, asMatch.index);
  const toTargetPattern =
    /\bTO\s+(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|`[^`]*`)(?:\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|`[^`]*`))?/i;
  return !toTargetPattern.test(header);
}

export function lintMigrationPolicyFile(
  filePath: string,
  content: string,
): MigrationPolicyViolation[] {
  const uncommentedContent = stripSqlComments(content);
  const statements = splitSqlStatements(uncommentedContent);
  const violations: MigrationPolicyViolation[] = [];

  for (const statement of statements) {
    for (const rule of riskyStatementRules) {
      if (rule.ruleName === "clickhouse-naive-materialized-view") {
        if (isNaiveClickHouseMaterializedView(statement.text)) {
          violations.push(buildViolation(filePath, statement, rule));
        }
        continue;
      }

      if (rule.pattern.test(statement.text)) {
        violations.push(buildViolation(filePath, statement, rule));
      }
    }

    if (isUnboundedUpdate(statement.text)) {
      violations.push(
        buildViolation(filePath, statement, {
          ruleName: "unbounded-update",
          pattern: /^\s*UPDATE\b/i,
          message: "Deploy migrations must not run unbounded UPDATE statements.",
        }),
      );
    }

    if (isUnboundedDelete(statement.text)) {
      violations.push(
        buildViolation(filePath, statement, {
          ruleName: "unbounded-delete",
          pattern: /^\s*DELETE\s+FROM\b/i,
          message: "Deploy migrations must not run unbounded DELETE statements.",
        }),
      );
    }
  }

  return violations;
}

function discoverMigrationFiles(paths: string[]): string[] {
  return paths.filter((path) => path.endsWith(".sql"));
}

export function lintMigrationPolicyPaths(paths: string[]): MigrationPolicyViolation[] {
  return discoverMigrationFiles(paths).flatMap((filePath) => {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return [];
    }
    return lintMigrationPolicyFile(filePath, readFileSync(filePath, "utf-8"));
  });
}

export function formatMigrationPolicyViolations(violations: MigrationPolicyViolation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.filePath}:${violation.lineNumber}: ${violation.ruleName}: ${violation.message}\n  ${violation.lineText}`,
    )
    .join("\n");
}

function main(): void {
  const violations = lintMigrationPolicyPaths(process.argv.slice(2));
  if (violations.length === 0) {
    console.log("Migration policy check passed.");
    return;
  }

  console.error(formatMigrationPolicyViolations(violations));
  process.exitCode = 1;
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main();
}
