/**
 * Automated removal of @ts-expect-error comments across the codebase.
 *
 * Handles several patterns:
 *
 * 1. Standalone `
 * 2. `MockFetchFn` type + `asMock` function definitions — removed.
 * 3. `X` call sites — replaced with just `X`.
 * 4. Inline `
 *
 * Run: npx tsx scripts/fix-ts-expect-errors.ts
 * Then: pnpm tsc --noEmit to see remaining errors.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

interface FileChange {
  file: string;
  removedLines: number;
  asMockReplacements: number;
  mockFetchFnRemoved: boolean;
  inlineStripped: number;
}

const changes: FileChange[] = [];

/**
 * Recursively find all .ts and .tsx files, excluding node_modules and routeTree.gen.ts.
 */
function findFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      results.push(...findFiles(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes("routeTree.gen")
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Remove `type MockFetchFn = ...` and the `function ...` block.
 * These are always a 1-line type + a multi-line function.
 */
function removeMockFetchFnAndAsMock(lines: string[]): { lines: string[]; removed: boolean } {
  let removed = false;
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Remove: type MockFetchFn = ReturnType<typeof vi.fn>;
    if (/^\s*type\s+MockFetchFn\s*=/.test(line)) {
      removed = true;
      continue;
    }

    // Remove: function fn: typeof globalThis.fetch: MockFetchFn {
    //
    //           return fn;
    //         }
    if (/^\s*function\s+asMock\s*\(/.test(line)) {
      removed = true;
      // Skip until closing brace
      let braceDepth = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }
        if (braceDepth <= 0) {
          i = j;
          break;
        }
      }
      continue;
    }

    output.push(line);
  }

  return { lines: output, removed };
}

/**
 * Replace `X` with `X` in all occurrences on a line.
 */
function replaceAsMock(line: string): { line: string; count: number } {
  let count = 0;
  // identifier — handle nested parens for things like setupFetchFn
  const replaced = line.replace(/asMock\(([^)]+)\)/g, (_match, inner: string) => {
    count++;
    return inner;
  });
  return { line: replaced, count };
}

/**
 * Process a single file.
 */
function processFile(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf8");

  // Quick check — skip files with nothing to do
  if (
    !content.includes("@ts-expect-error") &&
    !content.includes("asMock") &&
    !content.includes("MockFetchFn")
  ) {
    return;
  }

  let lines = content.split("\n");
  const change: FileChange = {
    file: path.relative(ROOT, filePath),
    removedLines: 0,
    asMockReplacements: 0,
    mockFetchFnRemoved: false,
    inlineStripped: 0,
  };

  // Step 1: Remove MockFetchFn type and asMock function definitions
  const step1 = removeMockFetchFnAndAsMock(lines);
  lines = step1.lines;
  change.mockFetchFnRemoved = step1.removed;

  // Step 2: Replace X call sites with X
  lines = lines.map((line) => {
    const result = replaceAsMock(line);
    change.asMockReplacements += result.count;
    return result.line;
  });

  // Step 3: Remove standalone @ts-expect-error comment lines
  // A standalone line is one where the entire line (after whitespace) is a @ts-expect-error comment.
  const filteredLines: string[] = [];
  for (const line of lines) {
    if (/^\s*\/\/\s*@ts-expect-error\b/.test(line)) {
      change.removedLines++;
      continue;
    }
    filteredLines.push(line);
  }
  lines = filteredLines;

  // Step 4: Strip inline @ts-expect-error from end of code lines
  // e.g., `});
  lines = lines.map((line) => {
    const inlineMatch = line.match(/^(.+?)\s*\/\/\s*@ts-expect-error\b.*$/);
    if (inlineMatch) {
      const codePart = inlineMatch[1];
      // Make sure there's actual code before the comment (not just whitespace)
      if (codePart.trim().length > 0) {
        change.inlineStripped++;
        return codePart.trimEnd();
      }
    }
    return line;
  });

  const totalChanges =
    change.removedLines +
    change.asMockReplacements +
    (change.mockFetchFnRemoved ? 1 : 0) +
    change.inlineStripped;

  if (totalChanges === 0) return;

  // Write the modified file
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  changes.push(change);
}

// --- Main ---

const dirs = ["src", "packages", "scripts"].map((d) => path.join(ROOT, d));
const allFiles: string[] = [];
for (const dir of dirs) {
  if (fs.existsSync(dir)) {
    allFiles.push(...findFiles(dir));
  }
}

console.log(`Scanning ${allFiles.length} files...\n`);

for (const file of allFiles) {
  processFile(file);
}

// Summary
console.log(`Modified ${changes.length} files:\n`);

let totalRemoved = 0;
let totalAsMock = 0;
let totalInline = 0;
let totalMockFetchFn = 0;

for (const c of changes) {
  const parts: string[] = [];
  if (c.removedLines > 0) parts.push(`${c.removedLines} @ts-expect-error lines removed`);
  if (c.asMockReplacements > 0) parts.push(`${c.asMockReplacements} asMock() replaced`);
  if (c.mockFetchFnRemoved) parts.push("MockFetchFn/asMock definition removed");
  if (c.inlineStripped > 0) parts.push(`${c.inlineStripped} inline comments stripped`);

  console.log(`  ${c.file}: ${parts.join(", ")}`);

  totalRemoved += c.removedLines;
  totalAsMock += c.asMockReplacements;
  totalInline += c.inlineStripped;
  if (c.mockFetchFnRemoved) totalMockFetchFn++;
}

console.log(`\nTotals:`);
console.log(`  @ts-expect-error lines removed: ${totalRemoved}`);
console.log(`  asMock() call sites replaced:   ${totalAsMock}`);
console.log(`  MockFetchFn/asMock defs removed: ${totalMockFetchFn}`);
console.log(`  Inline comments stripped:        ${totalInline}`);
console.log(
  `  Total changes:                   ${totalRemoved + totalAsMock + totalMockFetchFn + totalInline}`,
);
