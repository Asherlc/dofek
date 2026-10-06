import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSinceDate, parseSinceDays, resolveCliUserId } from "./cli.ts";

describe("parseSinceDays", () => {
  it("returns 7 when no --since-days arg is present", () => {
    expect(parseSinceDays(["node", "script.ts", "sync"])).toBe(7);
  });

  it("parses --since-days=14", () => {
    expect(parseSinceDays(["node", "script.ts", "sync", "--since-days=14"])).toBe(14);
  });

  it("parses --since-days=1", () => {
    expect(parseSinceDays(["node", "script.ts", "sync", "--since-days=1"])).toBe(1);
  });

  it("returns 7 when --since-days appears among other flags", () => {
    expect(
      parseSinceDays(["node", "script.ts", "sync", "--full-sync", "--since-days=30", "--verbose"]),
    ).toBe(30);
  });
});

describe("computeSinceDate", () => {
  it("returns epoch (Jan 1 1970) when fullSync is true", () => {
    const result = computeSinceDate(7, true);
    expect(result.getTime()).toBe(0);
  });

  it("returns a date approximately N days ago when fullSync is false", () => {
    const before = Date.now();
    const result = computeSinceDate(7, false);
    const after = Date.now();

    const expectedMs = 7 * 24 * 60 * 60 * 1000;
    // The result should be within a small window around "7 days ago"
    expect(result.getTime()).toBeGreaterThanOrEqual(before - expectedMs);
    expect(result.getTime()).toBeLessThanOrEqual(after - expectedMs);
  });

  it("returns approximately now when days is 0", () => {
    const before = Date.now();
    const result = computeSinceDate(0, false);
    const after = Date.now();

    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("resolveCliUserId", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses the configured user without querying", async () => {
    vi.stubEnv("DOFEK_USER_ID", "configured-user");
    const execute = vi.fn();
    const database = { execute };
    expect(await resolveCliUserId(database)).toBe("configured-user");
    expect(execute).not.toHaveBeenCalled();
  });
  it("uses the earliest database user when no user is configured", async () => {
    vi.stubEnv("DOFEK_USER_ID", "");
    const execute = vi.fn().mockResolvedValue([{ id: "oldest-user" }]);
    expect(await resolveCliUserId({ execute })).toBe("oldest-user");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("requires a configured or existing user", async () => {
    vi.stubEnv("DOFEK_USER_ID", "");
    const execute = vi.fn().mockResolvedValue([]);
    await expect(resolveCliUserId({ execute })).rejects.toThrow(
      "No user found. Set DOFEK_USER_ID or create a user first.",
    );
  });
});
