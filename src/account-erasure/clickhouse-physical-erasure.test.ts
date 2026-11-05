import { describe, expect, it } from "vitest";
import { classifyClickHouseManagedTableEngine } from "./clickhouse-physical-erasure.ts";

describe("classifyClickHouseManagedTableEngine", () => {
  it.each([
    ["MaterializedView", "non-storage"],
    ["Null", "non-storage"],
    ["View", "non-storage"],
    ["MergeTree", "merge-tree"],
    ["ReplacingMergeTree", "merge-tree"],
    ["Memory", "unsupported-storage"],
  ] as const)("classifies %s", (engine, expected) => {
    expect(classifyClickHouseManagedTableEngine(engine)).toBe(expected);
  });
});
