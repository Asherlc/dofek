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

function containsCanonicalCaptureOrThrow(node: ts.Node): boolean {
  let handled = false;

  function visit(currentNode: ts.Node): void {
    if (handled) {
      return;
    }
    if (ts.isThrowStatement(currentNode)) {
      handled = true;
      return;
    }
    if (
      ts.isCallExpression(currentNode) &&
      ts.isIdentifier(currentNode.expression) &&
      currentNode.expression.text === "captureException"
    ) {
      handled = true;
      return;
    }
    ts.forEachChild(currentNode, visit);
  }

  visit(node);
  return handled;
}

function hasOptionalHapticResultReturnType(
  catchClause: ts.CatchClause,
  sourceFile: ts.SourceFile,
): boolean {
  let currentNode: ts.Node | undefined = catchClause.parent;
  while (currentNode && !ts.isFunctionLike(currentNode)) {
    currentNode = currentNode.parent;
  }
  if (!currentNode || !currentNode.type) {
    return false;
  }
  return (
    currentNode.type.getText(sourceFile).replace(/\s+/g, "") === "Promise<OptionalHapticResult>"
  );
}

function isExplicitOptionalHapticUnavailableResult(
  catchClause: ts.CatchClause,
  sourceFile: ts.SourceFile,
): boolean {
  const catchVariable = catchClause.variableDeclaration?.name;
  if (
    !catchVariable ||
    !ts.isIdentifier(catchVariable) ||
    catchClause.block.statements.length !== 1
  ) {
    return false;
  }
  if (!hasOptionalHapticResultReturnType(catchClause, sourceFile)) {
    return false;
  }

  const statement = catchClause.block.statements[0];
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return false;
  }
  if (!ts.isObjectLiteralExpression(statement.expression)) {
    return false;
  }

  let unavailableStatus = false;
  let originalCause = false;
  for (const property of statement.expression.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText(sourceFile) === "status" &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === "unavailable"
    ) {
      unavailableStatus = true;
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === catchVariable.text &&
      property.name.text === "cause"
    ) {
      originalCause = true;
    }
    if (
      ts.isPropertyAssignment(property) &&
      property.name.getText(sourceFile) === "cause" &&
      ts.isIdentifier(property.initializer) &&
      property.initializer.text === catchVariable.text
    ) {
      originalCause = true;
    }
  }

  return unavailableStatus && originalCause;
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
    if (
      ts.isCatchClause(node) &&
      !containsCanonicalCaptureOrThrow(node.block) &&
      !isExplicitOptionalHapticUnavailableResult(node, sourceFile)
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
