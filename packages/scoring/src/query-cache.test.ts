import { describe, expect, it } from "vitest";
import { QUERY_CACHE_MAX_AGE_MS } from "./query-cache.ts";

describe("QUERY_CACHE_MAX_AGE_MS", () => {
  it("is 12 hours in milliseconds", () => {
    expect(QUERY_CACHE_MAX_AGE_MS).toBe(1000 * 60 * 60 * 12);
  });
});
