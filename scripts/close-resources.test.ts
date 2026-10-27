import { describe, expect, it } from "vitest";
import { closeResources } from "./close-resources.ts";

describe("closeResources", () => {
  it("settles every resource cleanup and reports every failure", async () => {
    const settled: string[] = [];
    const databaseFailure = new Error("database close failed");
    const analyticsFailure = new Error("analytics close failed");

    let cleanupError: unknown;
    try {
      await closeResources([
        {
          name: "Postgres",
          close: () => {
            settled.push("Postgres");
            throw databaseFailure;
          },
        },
        {
          name: "ClickHouse",
          close: async () => {
            settled.push("ClickHouse");
            throw analyticsFailure;
          },
        },
      ]);
    } catch (error) {
      cleanupError = error;
    }

    expect(settled).toEqual(["Postgres", "ClickHouse"]);
    if (!(cleanupError instanceof AggregateError)) {
      throw new Error("Expected cleanup failures to be aggregated");
    }
    expect(cleanupError.errors).toEqual([databaseFailure, analyticsFailure]);
    expect(cleanupError.message).toContain("Postgres, ClickHouse");
  });
});
