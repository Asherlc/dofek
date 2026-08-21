import { beforeEach, describe, expect, it, vi } from "vitest";

const captureExceptionMock = vi.hoisted(() => vi.fn());

vi.mock("./error-reporting.ts", () => ({
  captureException: captureExceptionMock,
}));

describe("RedisCacheStore error reporting", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  it("reports parse failures while evicting invalid Redis payloads", async () => {
    const client = {
      set: vi.fn(async () => "OK" as const),
      get: vi.fn(async () => "not-json"),
      del: vi.fn(async () => 1),
      sadd: vi.fn(async () => 0),
      smembers: vi.fn(async () => []),
      srem: vi.fn(async () => 1),
    };

    const { RedisCacheStore } = await import("./cache.ts");
    const store = new RedisCacheStore(async () => client);

    await expect(store.get("user-1:dashboard")).resolves.toBeUndefined();

    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      tags: { cacheStore: "redis", cacheOperation: "get" },
    });
  });
});
