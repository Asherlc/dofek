import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webSourceRoot = join(process.cwd(), "packages/web/src");

function listSourceFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
      continue;
    }
    if (entryPath.endsWith(".ts") || entryPath.endsWith(".tsx")) {
      files.push(entryPath);
    }
  }

  return files;
}

function readWebSource(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8");
}

describe("time range policy", () => {
  it("requires TimeRangeSelector consumers to use the central timeRange framework", () => {
    const frameworkMarkers = [
      "TimeRangeDays",
      "selectedRangeQueryInput",
      "minimumSelectedRangeQueryInput",
      "useBodyDays",
      "useTrainingDays",
    ];

    for (const sourceFile of listSourceFiles(webSourceRoot)) {
      const source = readWebSource(sourceFile);
      if (!source.includes("TimeRangeSelector")) continue;
      if (sourceFile.endsWith("TimeRangeSelector.tsx")) continue;
      if (sourceFile.includes(".test.")) continue;

      const relativePath = relative(webSourceRoot, sourceFile);
      expect(
        frameworkMarkers.some((marker) => source.includes(marker)),
        `${relativePath} must route selected chart ranges through timeRange.ts`,
      ).toBe(true);
    }
  });

  it("keeps selected range math inside timeRange.ts", () => {
    for (const sourceFile of listSourceFiles(webSourceRoot)) {
      if (sourceFile.endsWith("timeRange.ts")) continue;
      if (sourceFile.includes(".test.")) continue;

      const source = readWebSource(sourceFile);
      const relativePath = relative(webSourceRoot, sourceFile);
      expect(source, `${relativePath} must use minimumSelectedRangeQueryInput`).not.toContain(
        "Math.max(days",
      );
      const usesSelectedRangeFramework =
        source.includes("TimeRangeSelector") ||
        source.includes("selectedRangeQueryInput") ||
        source.includes("minimumSelectedRangeQueryInput");
      if (usesSelectedRangeFramework) {
        expect(source, `${relativePath} must not use sentinel All ranges`).not.toContain("3650");
      }
    }
  });
});
