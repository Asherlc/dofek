import { describe, expect, it } from "vitest";
import { sleepDedupCte } from "./sql-fragments.ts";

describe("sleepDedupCte", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = sleepDedupCte("user-1", "America/New_York", "2026-03-23", 30);
    expect(result.queryChunks).toBeDefined();
  });

  it("embeds userId and timezone in query chunks", () => {
    const result = sleepDedupCte("user-1", "America/New_York", "2026-03-23", 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("user-1");
    expect(chunks).toContain("America/New_York");
  });

  it("produces different SQL for different day values", () => {
    const fragmentA = sleepDedupCte("user-1", "UTC", "2026-03-23", 30);
    const fragmentB = sleepDedupCte("user-1", "UTC", "2026-03-23", 90);
    expect(fragmentA).not.toEqual(fragmentB);
  });

  it("includes both sleep_raw and sleep_deduped CTE names", () => {
    const result = sleepDedupCte("user-1", "UTC", "2026-03-23", 30);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("sleep_raw");
    expect(chunks).toContain("sleep_deduped");
  });
});
