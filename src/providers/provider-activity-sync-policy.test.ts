import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../..");

const SCAN_ROOTS = [
  join(REPO_ROOT, "src/providers"),
  join(REPO_ROOT, "packages/server/src/routers"),
  join(REPO_ROOT, "packages/server/src/repositories"),
];

const ALLOWED_TOMBSTONE_CLEAR_PATHS = new Set([
  "src/db/provider-activity-absence.ts",
  "packages/server/src/repositories/activity-repository.ts",
]);

const ALLOWED_ACTIVITY_INSERT_PATHS = new Set(["src/db/provider-activity-sync.ts"]);

function collectSourceFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(path));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("provider activity sync policy", () => {
  it("routes provider code through provider-activity-sync instead of provider-activity-absence", () => {
    const violations: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectSourceFiles(root)) {
        const relativePath = relative(REPO_ROOT, filePath);
        const contents = readFileSync(filePath, "utf8");
        if (
          contents.includes('from "../db/provider-activity-absence.ts"') ||
          contents.includes('from "../../db/provider-activity-absence.ts"') ||
          contents.includes('from "../../../../src/db/provider-activity-absence.ts"')
        ) {
          violations.push(relativePath);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not clear provider tombstones in provider activity upserts", () => {
    const violations: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectSourceFiles(root)) {
        const relativePath = relative(REPO_ROOT, filePath);
        if (ALLOWED_TOMBSTONE_CLEAR_PATHS.has(relativePath)) continue;

        const contents = readFileSync(filePath, "utf8");
        if (
          /providerAbsentAt:\s*null/.test(contents) ||
          /provider_absent_at\s*=\s*NULL/i.test(contents)
        ) {
          violations.push(relativePath);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("routes provider activity upserts through provider-activity-sync", () => {
    const violations: string[] = [];

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectSourceFiles(root)) {
        const relativePath = relative(REPO_ROOT, filePath);
        if (ALLOWED_ACTIVITY_INSERT_PATHS.has(relativePath)) continue;

        const contents = readFileSync(filePath, "utf8");
        if (/\.insert\(activity\)/.test(contents)) {
          violations.push(relativePath);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
