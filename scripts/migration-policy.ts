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

const drizzleConcurrentIndexRule: MigrationPolicyRule = {
  ruleName: "drizzle-concurrent-index",
  pattern: /\bCONCURRENTLY\b/i,
  message:
    "Drizzle-managed Postgres migrations run in a transaction and must not use concurrent index DDL.",
};

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

function buildFileViolation(
  filePath: string,
  ruleName: string,
  message: string,
  content: string,
): MigrationPolicyViolation {
  const lineText =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  return {
    filePath,
    lineNumber: 1,
    ruleName,
    message,
    lineText,
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

function isClickHouseFilePath(filePath: string): boolean {
  return filePath.startsWith("analytics/") || filePath.startsWith("src/db/clickhouse-sql/");
}

function isClickHouseOnlyRule(ruleName: string): boolean {
  return (
    ruleName.startsWith("clickhouse-") ||
    ruleName === "system-refresh-view" ||
    ruleName === "system-wait-view" ||
    ruleName === "refresh-every" ||
    ruleName === "optimize-final"
  );
}

function normalizeSqlRelationName(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function readMatchingRelation(
  statement: string,
  statementType: "create-table" | "drop-table" | "insert-into",
): string | null {
  const content = stripSqlStrings(statement);
  const match =
    statementType === "create-table"
      ? content.match(
          /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?)/i,
        )
      : statementType === "drop-table"
        ? content.match(
            /\bDROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?)/i,
          )
        : content.match(
            /\bINSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?)/i,
          );
  return match?.[1] ? normalizeSqlRelationName(match[1]) : null;
}

function readSourceRelations(statement: string): string[] {
  const content = stripSqlStrings(statement);
  const relations = new Set<string>();
  const pattern =
    /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)?)/gi;
  for (const match of content.matchAll(pattern)) {
    if (match[1]) relations.add(normalizeSqlRelationName(match[1]));
  }
  return [...relations];
}

function hasCommaJoin(statement: string): boolean {
  const fromClause = stripSqlStrings(statement)
    .split(/\bFROM\b/i, 2)[1]
    ?.split(/\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|RETURNING)\b|;/i, 1)[0];
  return fromClause?.includes(",") === true;
}

function isAtomicNormalizationCopy(
  statement: SqlStatement,
  createdRelations: Set<string>,
  droppedRelations: Set<string>,
): boolean {
  const target = readMatchingRelation(statement.text, "insert-into");
  if (!target || !createdRelations.has(target)) return false;
  if (hasCommaJoin(statement.text)) return false;

  const sources = readSourceRelations(statement.text);
  if (sources.length === 0) return false;
  return sources.every((source) => droppedRelations.has(source));
}

export function lintMigrationPolicyFile(
  filePath: string,
  content: string,
): MigrationPolicyViolation[] {
  const uncommentedContent = stripSqlComments(content);
  const statements = splitSqlStatements(uncommentedContent);
  const violations: MigrationPolicyViolation[] = [];
  const createdRelations = new Set(
    statements
      .map((statement) => readMatchingRelation(statement.text, "create-table"))
      .filter((relation): relation is string => relation != null),
  );
  const droppedRelations = new Set(
    statements
      .map((statement) => readMatchingRelation(statement.text, "drop-table"))
      .filter((relation): relation is string => relation != null),
  );

  if (
    filePath.startsWith("analytics/models/") &&
    !/\{\{\s*config\s*\([\s\S]*\bmaterialized\s*=\s*['"]incremental['"]/i.test(uncommentedContent)
  ) {
    violations.push(
      buildFileViolation(
        filePath,
        "analytics-dbt-incremental-model",
        "Analytics dbt models must be explicit incremental models; do not add view/table models that require full refreshes or live recomputation.",
        content,
      ),
    );
  }

  for (const statement of statements) {
    if (
      filePath.startsWith("drizzle/") &&
      drizzleConcurrentIndexRule.pattern.test(stripSqlStrings(statement.text))
    ) {
      violations.push(buildViolation(filePath, statement, drizzleConcurrentIndexRule));
    }

    for (const rule of riskyStatementRules) {
      if (isClickHouseOnlyRule(rule.ruleName) && !isClickHouseFilePath(filePath)) {
        continue;
      }

      if (rule.ruleName === "clickhouse-naive-materialized-view") {
        if (isNaiveClickHouseMaterializedView(statement.text)) {
          violations.push(buildViolation(filePath, statement, rule));
        }
        continue;
      }

      if (
        rule.ruleName === "insert-select" &&
        isAtomicNormalizationCopy(statement, createdRelations, droppedRelations)
      ) {
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
