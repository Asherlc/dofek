import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanActiveActivityPredicatePairing } from "./activity-visibility.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const EFFICIENCY_REPOSITORY_PATH =
  "packages/server/src/repositories/efficiency-repository.ts" as const;
const SCANNED_PATH_COUNT = 19;

describe("activity visibility predicates", () => {
  it("pairs provider_absent_at filters with deleted_at in scanned sources", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      readFileSync(join(repoRoot, relativePath), "utf8"),
    );

    expect(violations).toEqual([]);
  });

  it("reads every configured relative path", () => {
    const readPaths: string[] = [];
    scanActiveActivityPredicatePairing((relativePath) => {
      readPaths.push(relativePath);
      return "";
    });

    expect(readPaths).toHaveLength(SCANNED_PATH_COUNT);
    expect(new Set(readPaths).size).toBe(SCANNED_PATH_COUNT);
  });

  it("reports unpaired provider_absent_at filters on the same line", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      relativePath === EFFICIENCY_REPOSITORY_PATH ? "WHERE provider_absent_at IS NULL\n" : "",
    );

    expect(violations).toEqual([`${EFFICIENCY_REPOSITORY_PATH}:1`]);
  });

  it("accepts provider_absent_at and deleted_at on the same line", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      relativePath === EFFICIENCY_REPOSITORY_PATH
        ? "WHERE provider_absent_at IS NULL AND deleted_at IS NULL\n"
        : "",
    );

    expect(violations).toEqual([]);
  });

  it("accepts provider_absent_at and deleted_at on consecutive lines", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      relativePath === EFFICIENCY_REPOSITORY_PATH
        ? "AND provider_absent_at IS NULL\nAND deleted_at IS NULL\n"
        : "",
    );

    expect(violations).toEqual([]);
  });

  it("accepts lowercase null literals on consecutive lines", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      relativePath === EFFICIENCY_REPOSITORY_PATH
        ? "AND provider_absent_at IS null\nAND deleted_at IS null\n"
        : "",
    );

    expect(violations).toEqual([]);
  });

  it("ignores lines that do not mention provider_absent_at", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      relativePath === EFFICIENCY_REPOSITORY_PATH ? "AND deleted_at IS NULL\n" : "",
    );

    expect(violations).toEqual([]);
  });
});
