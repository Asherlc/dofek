import { describe, expect, it } from "vitest";
import {
  COMPANION_PAIRING_TTL_MS,
  getCompanionPairingStore,
  InMemoryCompanionPairingStore,
  normalizePairingCode,
  PAIRING_SHORT_CODE_PATTERN,
  parsePairingCodeInput,
  RedisCompanionPairingStore,
} from "./companion-pairing-store.ts";

interface FakeRedisEntry {
  value: string;
  expiresAtMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireArg(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined) {
    throw new Error(`Missing Redis script argument ${index}`);
  }
  return value;
}

function parseMilliseconds(value: string): number {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid Redis TTL: ${value}`);
  }
  return milliseconds;
}

class FakeRedisClient {
  #entries = new Map<string, FakeRedisEntry>();
  evalResults: unknown[] = [];
  evalCallCount = 0;
  nextEvalResult: unknown | undefined;

  async set(
    key: string,
    value: string,
    mode: "PX",
    millisecondsToExpire: number,
  ): Promise<"OK" | null> {
    if (mode !== "PX") {
      return null;
    }
    this.#setWithTtl(key, value, millisecondsToExpire);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(...keys: string[]): Promise<number> {
    let deletedCount = 0;
    for (const key of keys) {
      if (this.#entries.delete(key)) {
        deletedCount += 1;
      }
    }
    return deletedCount;
  }

  async eval(script: string, _keyCount: number, ...args: string[]): Promise<unknown> {
    this.evalCallCount += 1;
    if (this.evalResults.length > 0) {
      return this.evalResults.shift();
    }
    if (this.nextEvalResult !== undefined) {
      const result = this.nextEvalResult;
      this.nextEvalResult = undefined;
      return result;
    }
    if (script.includes("INCR")) {
      return this.#consumeClaimAttempt(args);
    }
    if (script.includes("cjson.decode")) {
      return this.#claimChallenge(script, args);
    }
    return this.#createChallenge(args);
  }

  corruptPairingPayload(pairingId: string): void {
    this.writePairingPayload(pairingId, "{");
  }

  writePairingPayload(pairingId: string, value: string): void {
    this.#entries.set(`companion-pairing:${pairingId}`, {
      value,
      expiresAtMs: Date.now() + COMPANION_PAIRING_TTL_MS,
    });
  }

  async deletePairingPayload(pairingId: string): Promise<void> {
    await this.del(`companion-pairing:${pairingId}`);
  }

  async readPairingPayload(pairingId: string): Promise<Record<string, unknown> | null> {
    const payload = await this.get(`companion-pairing:${pairingId}`);
    return payload ? JSON.parse(payload) : null;
  }

  async #createChallenge(args: string[]): Promise<number> {
    const codeKey = requireArg(args, 0);
    const challengeKey = requireArg(args, 1);
    const pairingId = requireArg(args, 2);
    const payload = requireArg(args, 3);
    const ttlMilliseconds = parseMilliseconds(requireArg(args, 4));

    if (await this.get(codeKey)) {
      return 0;
    }
    this.#setWithTtl(codeKey, pairingId, ttlMilliseconds);
    this.#setWithTtl(challengeKey, payload, ttlMilliseconds);
    return 1;
  }

  async #claimChallenge(script: string, args: string[]): Promise<string | null> {
    const codeKey = requireArg(args, 0);
    const pairingKeyPrefix = requireArg(args, 1);
    const claimedAt = requireArg(args, 2);
    const userId = requireArg(args, 3);
    const companionToken = args[4] ?? "";

    const pairingId = await this.get(codeKey);
    if (!pairingId) {
      return null;
    }

    const challengeKey = `${pairingKeyPrefix}${pairingId}`;
    const payload = await this.get(challengeKey);
    if (!payload) {
      await this.del(codeKey);
      return null;
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (error) {
      if (!script.includes("pcall(cjson.decode")) {
        throw error;
      }
      await this.del(codeKey, challengeKey);
      return null;
    }

    if (!isRecord(parsedPayload)) {
      await this.del(codeKey, challengeKey);
      return null;
    }
    if (parsedPayload.claimedAt !== undefined) {
      return null;
    }

    const updatedPayload = JSON.stringify({
      ...parsedPayload,
      claimedAt,
      userId,
      ...(companionToken ? { companionToken } : {}),
    });
    this.#entries.set(challengeKey, {
      value: updatedPayload,
      expiresAtMs: this.#entries.get(challengeKey)?.expiresAtMs ?? null,
    });
    return updatedPayload;
  }

  async #consumeClaimAttempt(args: string[]): Promise<number> {
    const claimAttemptKey = requireArg(args, 0);
    const ttlMilliseconds = parseMilliseconds(requireArg(args, 1));
    const currentValue = await this.get(claimAttemptKey);
    const nextCount = currentValue ? Number(currentValue) + 1 : 1;
    this.#entries.set(claimAttemptKey, {
      value: String(nextCount),
      expiresAtMs: this.#entries.get(claimAttemptKey)?.expiresAtMs ?? Date.now() + ttlMilliseconds,
    });
    return nextCount;
  }

  #setWithTtl(key: string, value: string, millisecondsToExpire: number): void {
    this.#entries.set(key, {
      value,
      expiresAtMs: Date.now() + millisecondsToExpire,
    });
  }
}

describe("InMemoryCompanionPairingStore", () => {
  it("creates retrievable pairing challenges", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");

    const challenge = await store.createChallenge(now);

    expect(challenge.id).toHaveLength(32);
    expect(challenge.shortCode).toMatch(PAIRING_SHORT_CODE_PATTERN);
    expect(await store.getById(challenge.id, now)).toEqual(challenge);
    expect(await store.getByShortCode(challenge.shortCode, now)).toEqual(challenge);
    expect(new Date(challenge.expiresAt).getTime() - now.getTime()).toBe(COMPANION_PAIRING_TTL_MS);
  });

  it("normalizes codes entered with spaces or dashes", () => {
    expect(normalizePairingCode("ab c-123")).toBe("ABC123");
    expect(normalizePairingCode(" ab c-123 ")).toBe("ABC123");
  });

  it("rejects short codes outside the generated alphabet", () => {
    expect(parsePairingCodeInput("ab c-234")).toBe("ABC234");
    expect(parsePairingCodeInput("I0O1AA")).toBeNull();
  });

  it("claims an unexpired challenge once", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    const claimed = await store.claimChallenge({
      shortCode: challenge.shortCode,
      userId: "user-1",
      companionToken: "dofek_companion_test",
      now,
    });

    expect(claimed).toMatchObject({
      id: challenge.id,
      userId: "user-1",
      companionToken: "dofek_companion_test",
      claimedAt: now.toISOString(),
    });
    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-2",
        companionToken: "dofek_companion_second",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("limits claim attempts per user inside the pairing window", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");
    // Matches companion-pairing-store.ts's CLAIM_ATTEMPT_WINDOW_MS, which is not exported.
    const claimAttemptWindowMs = 10 * 60 * 1000;

    for (let attemptNumber = 0; attemptNumber < 20; attemptNumber += 1) {
      await expect(store.consumeClaimAttempt("user-1", now)).resolves.toBe(true);
    }
    await expect(store.consumeClaimAttempt("user-1", now)).resolves.toBe(false);
    await expect(
      store.consumeClaimAttempt("user-1", new Date(now.getTime() + claimAttemptWindowMs + 1)),
    ).resolves.toBe(true);
  });

  it("expires stale challenges", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);
    const expiredAt = new Date(now.getTime() + COMPANION_PAIRING_TTL_MS + 1);
    const exactExpiry = new Date(now.getTime() + COMPANION_PAIRING_TTL_MS);

    expect(await store.getById(challenge.id, exactExpiry)).toBeNull();
    expect(await store.getById(challenge.id, expiredAt)).toBeNull();
    expect(await store.getByShortCode(challenge.shortCode, expiredAt)).toBeNull();
  });

  it("rejects expired claims", async () => {
    const store = new InMemoryCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);
    const expiredAt = new Date(now.getTime() + COMPANION_PAIRING_TTL_MS);

    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
        now: expiredAt,
      }),
    ).resolves.toBeNull();
    await expect(store.getByShortCode(challenge.shortCode, now)).resolves.toBeNull();
  });

  it("returns null for missing in-memory challenge lookups", async () => {
    const store = new InMemoryCompanionPairingStore();

    await expect(store.getById("missing")).resolves.toBeNull();
    await expect(store.getByShortCode("ABC234")).resolves.toBeNull();
  });
});

describe("RedisCompanionPairingStore", () => {
  it("creates retrievable Redis pairing challenges", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");

    const challenge = await store.createChallenge(now);

    await expect(store.getById(challenge.id, now)).resolves.toEqual(challenge);
    await expect(store.getByShortCode(` ${challenge.shortCode} `, now)).resolves.toEqual(challenge);
  });

  it("retries Redis pairing code collisions and fails after repeated collisions", async () => {
    const collisionClient = new FakeRedisClient();
    const retryingStore = new RedisCompanionPairingStore(async () => collisionClient);
    collisionClient.evalResults = [0];

    await expect(retryingStore.createChallenge()).resolves.toMatchObject({
      shortCode: expect.stringMatching(PAIRING_SHORT_CODE_PATTERN),
    });
    expect(collisionClient.evalCallCount).toBe(2);

    const exhaustedClient = new FakeRedisClient();
    const exhaustedStore = new RedisCompanionPairingStore(async () => exhaustedClient);
    exhaustedClient.evalResults = [0, 0, 0, 0, 0];

    await expect(exhaustedStore.createChallenge()).rejects.toThrow(
      "Failed to allocate unique companion pairing code",
    );
    expect(exhaustedClient.evalCallCount).toBe(5);
  });

  it("uses Redis to limit claim attempts per user", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);

    for (let attemptNumber = 0; attemptNumber < 20; attemptNumber += 1) {
      await expect(store.consumeClaimAttempt("user-1")).resolves.toBe(true);
    }

    await expect(store.consumeClaimAttempt("user-1")).resolves.toBe(false);
    await expect(store.consumeClaimAttempt("user-2")).resolves.toBe(true);
  });

  it("fails loudly when Redis claim attempts return a non-numeric value", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    redisClient.nextEvalResult = "1";

    await expect(store.consumeClaimAttempt("user-1")).rejects.toThrow(
      "Redis companion pairing claim attempt limiter returned a non-numeric count",
    );
  });

  it("can claim a Redis challenge without a companion token", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    const claimed = await store.claimChallenge({
      shortCode: challenge.shortCode,
      userId: "user-1",
      now,
    });
    expect(claimed).toMatchObject({ id: challenge.id, userId: "user-1" });
    expect(claimed?.companionToken).toBeUndefined();
    expect(await redisClient.readPairingPayload(challenge.id)).not.toHaveProperty("companionToken");
  });

  it("can claim a Redis challenge with a companion token in one step", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
        now,
      }),
    ).resolves.toMatchObject({ companionToken: "dofek_companion_test" });
  });

  it("expires stale Redis challenges", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);
    const expiredAt = new Date(now.getTime() + COMPANION_PAIRING_TTL_MS);

    await expect(store.getById(challenge.id, expiredAt)).resolves.toBeNull();
    await expect(store.getByShortCode(challenge.shortCode, now)).resolves.toBeNull();
  });

  it("returns null for missing Redis short-code and challenge records", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    await expect(store.getByShortCode("ABC234", now)).resolves.toBeNull();
    await expect(store.getById("missing", now)).resolves.toBeNull();

    await redisClient.deletePairingPayload(challenge.id);
    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("returns null and deletes malformed Redis challenge records", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    redisClient.writePairingPayload(challenge.id, JSON.stringify({ id: 123 }));

    await expect(store.getById(challenge.id, now)).resolves.toBeNull();
    await expect(redisClient.readPairingPayload(challenge.id)).resolves.toBeNull();
  });

  it("returns null when Redis claim scripts do not return a payload", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);
    redisClient.nextEvalResult = 1;

    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for corrupted Redis claim payloads", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    redisClient.corruptPairingPayload(challenge.id);

    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
        now,
      }),
    ).resolves.toBeNull();
    await expect(store.getByShortCode(challenge.shortCode, now)).resolves.toBeNull();
  });

  it("returns null when Redis returns a malformed claimed payload", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);
    redisClient.nextEvalResult = "{";

    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
        now,
      }),
    ).resolves.toBeNull();
  });
});

describe("getCompanionPairingStore", () => {
  it("uses the in-memory store in tests", () => {
    expect(getCompanionPairingStore()).toBeInstanceOf(InMemoryCompanionPairingStore);
  });
});
