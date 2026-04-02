import { describe, expect, it, vi } from "vitest";
import {
  InMemoryWhoopVerificationChallengeStore,
  RedisWhoopVerificationChallengeStore,
} from "./whoop-verification-challenge-store.ts";

describe("InMemoryWhoopVerificationChallengeStore", () => {
  it("stores, loads, and deletes challenge sessions", async () => {
    const challengeStore = new InMemoryWhoopVerificationChallengeStore();

    await challengeStore.save("challenge-1", {
      session: "session-abc",
      method: "sms",
      username: "user@example.com",
      expiresAt: Date.now() + 60_000,
    });

    expect(await challengeStore.get("challenge-1")).toEqual({
      session: "session-abc",
      method: "sms",
      username: "user@example.com",
      expiresAt: expect.any(Number),
    });

    await challengeStore.delete("challenge-1");
    expect(await challengeStore.get("challenge-1")).toBeNull();
  });

  it("expires challenge sessions after ttl", async () => {
    vi.useFakeTimers();
    const challengeStore = new InMemoryWhoopVerificationChallengeStore();

    await challengeStore.save(
      "challenge-expiring",
      {
        session: "session-expiring",
        method: "sms",
        username: "user@example.com",
        expiresAt: Date.now() + 100,
      },
      100,
    );

    vi.advanceTimersByTime(101);
    expect(await challengeStore.get("challenge-expiring")).toBeNull();
    vi.useRealTimers();
  });
});

describe("RedisWhoopVerificationChallengeStore", () => {
  it("persists challenges in redis format and loads them back", async () => {
    const setMethod = vi.fn(async () => "OK");
    const getMethod = vi.fn(async () =>
      JSON.stringify({
        session: "session-from-redis",
        method: "sms",
        username: "user@example.com",
        expiresAt: 12345,
      }),
    );
    const deleteMethod = vi.fn(async () => 1);

    const challengeStore = new RedisWhoopVerificationChallengeStore(async () => ({
      set: setMethod,
      get: getMethod,
      del: deleteMethod,
    }));

    await challengeStore.save("challenge-redis", {
      session: "session-from-redis",
      method: "sms",
      username: "user@example.com",
      expiresAt: 12345,
    });

    expect(setMethod).toHaveBeenCalledWith(
      "whoop:verification:challenge-redis",
      expect.any(String),
      "PX",
      600_000,
    );

    const loadedChallenge = await challengeStore.get("challenge-redis");
    expect(loadedChallenge).toEqual({
      session: "session-from-redis",
      method: "sms",
      username: "user@example.com",
      expiresAt: 12345,
    });

    await challengeStore.delete("challenge-redis");
    expect(deleteMethod).toHaveBeenCalledWith("whoop:verification:challenge-redis");
  });
});
