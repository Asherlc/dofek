import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface HandledMobileErrorViolation {
  column: number;
  filePath: string;
  kind: "catch-clause" | "promise-catch";
  line: number;
}

const CANONICAL_ERROR_REPORTERS = new Set(["captureException", "handleWorkoutRouteError"]);

function isCanonicalCaptureCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    CANONICAL_ERROR_REPORTERS.has(node.expression.text)
  );
}

function statementAlwaysHandles(
  statement: ts.Statement,
  caughtIdentifier: string | undefined,
): boolean {
  if (ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isExpressionStatement(statement)) {
    return isCanonicalCaptureCall(statement.expression);
  }
  if (ts.isBlock(statement)) {
    return statementsContainReachableHandler(statement.statements, caughtIdentifier);
  }
  if (ts.isIfStatement(statement) && statement.elseStatement) {
    return (
      statementAlwaysHandles(statement.thenStatement, caughtIdentifier) &&
      statementAlwaysHandles(statement.elseStatement, caughtIdentifier)
    );
  }
  return false;
}

function isExpectedErrorGuard(
  statement: ts.Statement,
  caughtIdentifier: string | undefined,
): boolean {
  if (
    !caughtIdentifier ||
    !ts.isIfStatement(statement) ||
    statement.elseStatement ||
    !statementAlwaysHandles(statement.thenStatement, caughtIdentifier) ||
    !ts.isPrefixUnaryExpression(statement.expression) ||
    statement.expression.operator !== ts.SyntaxKind.ExclamationToken ||
    !ts.isCallExpression(statement.expression.operand) ||
    !ts.isIdentifier(statement.expression.operand.expression) ||
    !statement.expression.operand.expression.text.startsWith("is")
  ) {
    return false;
  }
  return statement.expression.operand.arguments.some(
    (argument) => ts.isIdentifier(argument) && argument.text === caughtIdentifier,
  );
}

function statementsContainReachableHandler(
  statements: ts.NodeArray<ts.Statement>,
  caughtIdentifier: string | undefined,
): boolean {
  for (const statement of statements) {
    if (
      statementAlwaysHandles(statement, caughtIdentifier) ||
      isExpectedErrorGuard(statement, caughtIdentifier)
    ) {
      return true;
    }
    if (ts.isReturnStatement(statement)) {
      return false;
    }
  }
  return false;
}

function containsCanonicalCaptureOrThrow(node: ts.Node, caughtIdentifier?: string): boolean {
  if (isCanonicalCaptureCall(node)) {
    return true;
  }
  if (ts.isIdentifier(node) && CANONICAL_ERROR_REPORTERS.has(node.text)) {
    return true;
  }
  if (ts.isBlock(node)) {
    return statementsContainReachableHandler(node.statements, caughtIdentifier);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const handlerParameter = node.parameters[0]?.name;
    const handlerIdentifier = ts.isIdentifier(handlerParameter)
      ? handlerParameter.text
      : caughtIdentifier;
    return ts.isBlock(node.body)
      ? statementsContainReachableHandler(node.body.statements, handlerIdentifier)
      : isCanonicalCaptureCall(node.body);
  }
  return false;
}

function makeViolation(
  filePath: string,
  kind: HandledMobileErrorViolation["kind"],
  node: ts.Node,
  sourceFile: ts.SourceFile,
): HandledMobileErrorViolation {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    column: position.character + 1,
    filePath,
    kind,
    line: position.line + 1,
  };
}

export function findHandledMobileErrorViolations(
  filePath: string,
  sourceText: string,
): HandledMobileErrorViolation[] {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const violations: HandledMobileErrorViolation[] = [];

  function visit(node: ts.Node): void {
    const catchVariable = ts.isCatchClause(node) ? node.variableDeclaration?.name : undefined;
    if (
      ts.isCatchClause(node) &&
      !containsCanonicalCaptureOrThrow(
        node.block,
        catchVariable && ts.isIdentifier(catchVariable) ? catchVariable.text : undefined,
      )
    ) {
      violations.push(makeViolation(filePath, "catch-clause", node, sourceFile));
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const handler = node.arguments[0];
      if (handler && !containsCanonicalCaptureOrThrow(handler)) {
        violations.push(makeViolation(filePath, "promise-catch", node, sourceFile));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function isProductionTypeScriptFile(filePath: string): boolean {
  const filename = path.basename(filePath);
  return (
    /\.(ts|tsx)$/.test(filename) &&
    !/\.(test|stories)\.(ts|tsx)$/.test(filename) &&
    !filePath.split(path.sep).some((segment) => segment.startsWith("."))
  );
}

function listProductionTypeScriptFiles(inputPath: string): string[] {
  if (!statSync(inputPath).isDirectory()) {
    return isProductionTypeScriptFile(inputPath) ? [inputPath] : [];
  }

  const files: string[] = [];
  for (const directoryEntry of readdirSync(inputPath, { withFileTypes: true })) {
    if (
      directoryEntry.name === "node_modules" ||
      (directoryEntry.isDirectory() && directoryEntry.name.startsWith("."))
    ) {
      continue;
    }
    const entryPath = path.join(inputPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      files.push(...listProductionTypeScriptFiles(entryPath));
    } else if (isProductionTypeScriptFile(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

export function scanMobileProductionFiles(inputPath: string): HandledMobileErrorViolation[] {
  return listProductionTypeScriptFiles(inputPath)
    .sort()
    .flatMap((filePath) =>
      findHandledMobileErrorViolations(filePath, readFileSync(filePath, "utf8")),
    );
}

function runCommandLine(): void {
  const inputPath = process.argv[2] ?? "packages/mobile";
  const violations = scanMobileProductionFiles(inputPath);
  if (violations.length === 0) {
    console.log("Mobile handled-error telemetry policy passed.");
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.filePath}:${violation.line}:${violation.column} ${violation.kind} consumes an unexpected error without canonical captureException() or rethrowing`,
    );
  }
  process.exitCode = 1;
}

const commandPath = process.argv[1];
if (commandPath && pathToFileURL(path.resolve(commandPath)).href === import.meta.url) {
  runCommandLine();
}
