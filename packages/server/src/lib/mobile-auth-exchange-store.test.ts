import { beforeEach, describe, expect, it, vi } from "vitest";

const redisClient = vi.hoisted(() => ({
  set: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("bullmq", () => ({
  RedisConnection: vi.fn(() => ({ client: Promise.resolve(redisClient) })),
}));

vi.mock("dofek/jobs/queues", () => ({
  getRedisConnection: vi.fn(),
}));

import {
  InMemoryMobileAuthExchangeStore,
  RedisMobileAuthExchangeStore,
} from "./mobile-auth-exchange-store.ts";

beforeEach(() => {
  vi.clearAllMocks();
  redisClient.set.mockResolvedValue("OK");
});

describe("InMemoryMobileAuthExchangeStore", () => {
  it("consumes a code only once", async () => {
    const store = new InMemoryMobileAuthExchangeStore();
    const code = await store.issue({ kind: "session", sessionId: "session-1", isNewUser: false });

    await expect(store.consume(code)).resolves.toEqual({
      kind: "session",
      sessionId: "session-1",
      isNewUser: false,
    });
    await expect(store.consume(code)).resolves.toBeNull();
  });

  it("rejects expired codes", async () => {
    const store = new InMemoryMobileAuthExchangeStore({ ttlMs: 1 });
    const code = await store.issue({ kind: "session", sessionId: "session-1", isNewUser: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(store.consume(code)).resolves.toBeNull();
  });
});

describe("RedisMobileAuthExchangeStore", () => {
  it("stores and atomically consumes a session payload", async () => {
    const payload = { kind: "session" as const, sessionId: "session-1", isNewUser: true };
    redisClient.sendCommand.mockResolvedValueOnce(JSON.stringify(payload));
    const store = new RedisMobileAuthExchangeStore();

    const code = await store.issue(payload);
    await expect(store.consume(code)).resolves.toEqual(payload);

    expect(redisClient.set).toHaveBeenCalledWith(
      expect.stringMatching(/^mobile-auth-exchange:[a-f0-9]{64}$/),
      JSON.stringify(payload),
      { PX: 60_000 },
    );
    expect(redisClient.sendCommand).toHaveBeenCalledWith([
      "GETDEL",
      expect.stringMatching(/^mobile-auth-exchange:[a-f0-9]{64}$/),
    ]);
  });

  it("rejects malformed and invalid Redis payloads", async () => {
    const store = new RedisMobileAuthExchangeStore(async () => ({
      set: vi.fn().mockResolvedValue("OK"),
      getAndDelete: vi
        .fn()
        .mockResolvedValueOnce("not-json")
        .mockResolvedValueOnce(JSON.stringify({ kind: "unknown" })),
    }));

    await expect(store.consume("malformed")).resolves.toBeNull();
    await expect(store.consume("invalid")).resolves.toBeNull();
  });
});
