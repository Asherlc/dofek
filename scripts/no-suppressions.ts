import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const forbiddenSuppressionPatterns = [
  ["@", "ts-ignore"].join(""),
  ["@", "ts-expect-error"].join(""),
  ["@", "ts-nocheck"].join(""),
  ["biome", "-ignore"].join(""),
  ["eslint", "-disable"].join(""),
  ["Stryker", " disable"].join(""),
  ["istanbul", " ignore"].join(""),
  ["c8", " ignore"].join(""),
];

function isExcluded(filePath: string): boolean {
  return (
    path.posix.basename(filePath) === "routeTree.gen.ts" ||
    filePath === "scripts/fix-ts-expect-errors.ts"
  );
}

function trackedTypeScriptFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--", "*.ts", "*.tsx"], {
    encoding: "utf8",
  });

  return output
    .split("\0")
    .filter((filePath) => filePath.length > 0 && existsSync(filePath) && !isExcluded(filePath))
    .sort();
}

let foundSuppression = false;

for (const filePath of trackedTypeScriptFiles()) {
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    for (const forbiddenSuppression of forbiddenSuppressionPatterns) {
      if (!line.includes(forbiddenSuppression)) continue;
      console.error(`${filePath}:${lineIndex + 1}: ${forbiddenSuppression}`);
      foundSuppression = true;
    }
  }
}

if (foundSuppression) {
  console.error(
    `\nERROR: Found suppression comments. Fix the underlying issue instead of suppressing.\nBanned patterns: ${forbiddenSuppressionPatterns.join(" ")}`,
  );
  process.exitCode = 1;
} else {
  console.log("No suppression comments found.");
}
