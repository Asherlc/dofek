import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanActiveActivityPredicatePairing } from "./activity-visibility.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("activity visibility predicates", () => {
  it("pairs provider_absent_at filters with deleted_at in scanned sources", () => {
    const violations = scanActiveActivityPredicatePairing((relativePath) =>
      readFileSync(join(repoRoot, relativePath), "utf8"),
    );

    expect(violations).toEqual([]);
  });
});
