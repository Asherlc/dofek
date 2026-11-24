import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { missingStoryIds, requireStoryIdsInIndex } from "./screenshot-config";

const syntheticIndexes: string[] = [];

afterEach(() => {
  while (syntheticIndexes.length > 0) {
    const directory = syntheticIndexes.pop();
    if (directory == null) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSyntheticIndex(entries: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), "screenshot-index-"));
  syntheticIndexes.push(directory);
  writeFileSync(join(directory, "index.json"), JSON.stringify({ entries }));
  return directory;
}

describe("screenshot story preflight", () => {
  it("lists story ids missing from parsed index entries", () => {
    expect(
      missingStoryIds(
        { "pages-overview--app-store-screenshot": {}, "pages-recovery--default": {} },
        ["pages-overview--app-store-screenshot", "pages-missing--default"],
      ),
    ).toEqual(["pages-missing--default"]);
  });

  it("fails when a requested screenshot story is missing from a synthetic index", () => {
    const directory = createSyntheticIndex({
      "pages-overview--app-store-screenshot": { id: "pages-overview--app-store-screenshot" },
    });

    expect(() =>
      requireStoryIdsInIndex(directory, [
        "pages-overview--app-store-screenshot",
        "pages-missing--default",
      ]),
    ).toThrow(/pages-missing--default/);
  });

  it("accepts a synthetic index that contains every requested story id", () => {
    const directory = createSyntheticIndex({
      "pages-overview--app-store-screenshot": {},
      "pages-recovery--default": {},
    });

    expect(() =>
      requireStoryIdsInIndex(directory, [
        "pages-overview--app-store-screenshot",
        "pages-recovery--default",
      ]),
    ).not.toThrow();
  });
});
