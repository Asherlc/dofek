import { describe, expect, it } from "vitest";
import { LatestOperation } from "./latest-operation.ts";

describe("LatestOperation", () => {
  it("invalidates an earlier operation when a newer one starts", () => {
    const operations = new LatestOperation();
    const verification = operations.begin();
    const disconnect = operations.begin();

    expect(operations.isCurrent(verification)).toBe(false);
    expect(operations.isCurrent(disconnect)).toBe(true);
  });
});
