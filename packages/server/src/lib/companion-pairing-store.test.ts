import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_PAIRING_TTL_MS,
  getCompanionPairingStore,
  InMemoryCompanionPairingStore,
  normalizePairingCode,
  PAIRING_SHORT_CODE_PATTERN,
  parsePairingCodeInput,
  RedisCompanionPairingStore,
} from "./companion-pairing-store.ts";

const companionPairingStoreMocks = vi.hoisted(() => {
  let sharedRedisClient: unknown = null;
  const queueConnection = { connectionName: "test-queue-connection" };
  return {
    mockGetRedisConnection: vi.fn(() => queueConnection),
    mockCaptureException: vi.fn(),
    mockRedisConnectionConstructor: vi.fn(function RedisConnection() {
      return {
        get client(): Promise<unknown> {
          return Promise.resolve(sharedRedisClient);
        },
      };
    }),
    queueConnection,
    setSharedRedisClient(value: unknown): void {
      sharedRedisClient = value;
    },
  };
});

vi.mock("bullmq", () => ({
  RedisConnection: companionPairingStoreMocks.mockRedisConnectionConstructor,
}));

vi.mock("dofek/jobs/queues", () => ({
  getRedisConnection: companionPairingStoreMocks.mockGetRedisConnection,
}));

vi.mock("@sentry/node", () => ({
  captureException: companionPairingStoreMocks.mockCaptureException,
}));

interface FakeRedisEntry {
  value: string;
  expiresAtMs: number | null;
}

interface FakeRedisEvalCall {
  script: string;
  keyCount: number;
  args: string[];
}

function fakePairingKey(pairingId: string): string {
  return `companion-pairing:{companion-pairing}:challenge:${pairingId}`;
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
  evalCalls: FakeRedisEvalCall[] = [];
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

  async eval(script: string, keyCount: number, ...args: string[]): Promise<unknown> {
    this.evalCallCount += 1;
    this.evalCalls.push({ script, keyCount, args });
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
    if (script.includes('challenge["companionToken"] = ARGV[3]')) {
      return this.#setClaimedChallengeToken(script, args);
    }
    if (script.includes('challenge["tokenIssuing"] = nil')) {
      return this.#releaseClaimedChallengeTokenIssuance(script, args);
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
    this.#entries.set(fakePairingKey(pairingId), {
      value,
      expiresAtMs: Date.now() + COMPANION_PAIRING_TTL_MS,
    });
  }

  async deletePairingPayload(pairingId: string): Promise<void> {
    await this.del(fakePairingKey(pairingId));
  }

  async readPairingPayload(pairingId: string): Promise<Record<string, unknown> | null> {
    const payload = await this.get(fakePairingKey(pairingId));
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
    const challengeKey = requireArg(args, 1);
    const expectedPairingId = requireArg(args, 2);
    const claimedAt = requireArg(args, 3);
    const userId = requireArg(args, 4);

    const pairingId = await this.get(codeKey);
    if (!pairingId || pairingId !== expectedPairingId) {
      return null;
    }

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
      if (
        parsedPayload.userId !== userId ||
        parsedPayload.companionToken !== undefined ||
        parsedPayload.tokenIssuing === true
      ) {
        return null;
      }
    }

    const updatedPayload = JSON.stringify({
      ...parsedPayload,
      claimedAt,
      userId,
      tokenIssuing: true,
    });
    this.#entries.set(challengeKey, {
      value: updatedPayload,
      expiresAtMs: this.#entries.get(challengeKey)?.expiresAtMs ?? null,
    });
    return updatedPayload;
  }

  async #setClaimedChallengeToken(script: string, args: string[]): Promise<string | null> {
    const codeKey = requireArg(args, 0);
    const challengeKey = requireArg(args, 1);
    const expectedPairingId = requireArg(args, 2);
    const userId = requireArg(args, 3);
    const companionToken = requireArg(args, 4);
    const pairingId = await this.get(codeKey);
    if (!pairingId || pairingId !== expectedPairingId) return null;
    const payload = await this.get(challengeKey);
    if (!payload) return null;
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (error) {
      if (!script.includes("pcall(cjson.decode")) throw error;
      await this.del(codeKey, challengeKey);
      return null;
    }
    if (
      !isRecord(parsedPayload) ||
      parsedPayload.claimedAt === undefined ||
      parsedPayload.userId !== userId ||
      parsedPayload.tokenIssuing !== true
    ) {
      return null;
    }
    if (parsedPayload.companionToken !== undefined) return payload;
    const { tokenIssuing: _tokenIssuing, ...claimedChallenge } = parsedPayload;
    const updatedPayload = JSON.stringify({ ...claimedChallenge, companionToken });
    this.#entries.set(challengeKey, {
      value: updatedPayload,
      expiresAtMs: this.#entries.get(challengeKey)?.expiresAtMs ?? null,
    });
    return updatedPayload;
  }

  async #releaseClaimedChallengeTokenIssuance(
    script: string,
    args: string[],
  ): Promise<string | null> {
    const codeKey = requireArg(args, 0);
    const challengeKey = requireArg(args, 1);
    const expectedPairingId = requireArg(args, 2);
    const userId = requireArg(args, 3);
    const pairingId = await this.get(codeKey);
    if (!pairingId || pairingId !== expectedPairingId) return null;
    const payload = await this.get(challengeKey);
    if (!payload) return null;
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch (error) {
      if (!script.includes("pcall(cjson.decode")) throw error;
      await this.del(codeKey, challengeKey);
      return null;
    }
    if (
      !isRecord(parsedPayload) ||
      parsedPayload.claimedAt === undefined ||
      parsedPayload.userId !== userId ||
      parsedPayload.tokenIssuing !== true ||
      parsedPayload.companionToken !== undefined
    ) {
      return null;
    }
    const { tokenIssuing: _tokenIssuing, ...releasedChallenge } = parsedPayload;
    const updatedPayload = JSON.stringify(releasedChallenge);
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
      now,
    });

    const paired = await store.setClaimedChallengeToken({
      shortCode: challenge.shortCode,
      userId: "user-1",
      companionToken: "dofek_companion_test",
      now,
    });

    expect(claimed).toMatchObject({
      id: challenge.id,
      userId: "user-1",
      claimedAt: now.toISOString(),
    });
    expect(paired).toMatchObject({ companionToken: "dofek_companion_test" });
    await expect(
      store.claimChallenge({
        shortCode: challenge.shortCode,
        userId: "user-2",
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

  it("allows the claim winner to recover after token issuance fails without rotating twice", async () => {
    const store = new InMemoryCompanionPairingStore();
    const challenge = await store.createChallenge();

    await expect(
      store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" }),
    ).resolves.toMatchObject({ tokenIssuing: true });
    await expect(
      store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" }),
    ).resolves.toBeNull();
    const releasedChallenge = await store.releaseClaimedChallengeTokenIssuance({
      shortCode: challenge.shortCode,
      userId: "user-1",
    });
    expect(releasedChallenge).not.toHaveProperty("tokenIssuing");
    await expect(
      store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" }),
    ).resolves.toMatchObject({ tokenIssuing: true });
  });

  it("keeps a released claim owned by its original user", async () => {
    const store = new InMemoryCompanionPairingStore();
    const challenge = await store.createChallenge();

    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });
    await store.releaseClaimedChallengeTokenIssuance({
      shortCode: challenge.shortCode,
      userId: "user-1",
    });

    await expect(
      store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-2" }),
    ).resolves.toBeNull();
  });

  it("attaches a token only while its claim is held by that user", async () => {
    const store = new InMemoryCompanionPairingStore();
    const challenge = await store.createChallenge();

    await expect(
      store.setClaimedChallengeToken({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
      }),
    ).resolves.toBeNull();
    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });
    await expect(
      store.setClaimedChallengeToken({
        shortCode: challenge.shortCode,
        userId: "user-2",
        companionToken: "dofek_companion_second",
      }),
    ).resolves.toBeNull();
    await store.setClaimedChallengeToken({
      shortCode: challenge.shortCode,
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
    await expect(
      store.setClaimedChallengeToken({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_second",
      }),
    ).resolves.toBeNull();
  });

  it("releases only an unfinished token issuance held by that user", async () => {
    const store = new InMemoryCompanionPairingStore();
    const challenge = await store.createChallenge();

    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-1",
      }),
    ).resolves.toBeNull();
    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });
    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-2",
      }),
    ).resolves.toBeNull();
    await store.setClaimedChallengeToken({
      shortCode: challenge.shortCode,
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-1",
      }),
    ).resolves.toBeNull();
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

  it("attaches a token only after atomically claiming a Redis challenge", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1", now });
    await expect(
      store.setClaimedChallengeToken({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
      }),
    ).resolves.toMatchObject({ companionToken: "dofek_companion_test" });
    expect(redisClient.evalCalls.at(-1)).toMatchObject({
      keyCount: 2,
      args: [
        `companion-pairing:{companion-pairing}:code:${challenge.shortCode}`,
        fakePairingKey(challenge.id),
        challenge.id,
        "user-1",
        "dofek_companion_test",
      ],
    });
  });

  it("returns null when Redis token attachment cannot produce a challenge", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const challenge = await store.createChallenge();

    await expect(
      store.setClaimedChallengeToken({
        shortCode: "ABC234",
        userId: "user-1",
        companionToken: "dofek_companion_test",
      }),
    ).resolves.toBeNull();
    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });
    redisClient.nextEvalResult = 1;
    await expect(
      store.setClaimedChallengeToken({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
      }),
    ).resolves.toBeNull();
    redisClient.nextEvalResult = "{";
    await expect(
      store.setClaimedChallengeToken({
        shortCode: challenge.shortCode,
        userId: "user-1",
        companionToken: "dofek_companion_test",
      }),
    ).resolves.toBeNull();
    expect(companionPairingStoreMocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      {
        extra: { companionPairingShortCode: challenge.shortCode },
      },
    );
  });

  it("releases an unfinished Redis token issuance only for its claim owner", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const challenge = await store.createChallenge();
    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });

    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-2",
      }),
    ).resolves.toBeNull();
    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({ userId: "user-1" });
    expect(await redisClient.readPairingPayload(challenge.id)).not.toHaveProperty("tokenIssuing");
  });

  it("returns null when releasing a Redis token issuance cannot produce a challenge", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const challenge = await store.createChallenge();

    await expect(
      store.releaseClaimedChallengeTokenIssuance({ shortCode: "ABC234", userId: "user-1" }),
    ).resolves.toBeNull();
    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });
    redisClient.nextEvalResult = 1;
    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-1",
      }),
    ).resolves.toBeNull();
    redisClient.nextEvalResult = "{";
    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-1",
      }),
    ).resolves.toBeNull();
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

  it("reports corrupted Redis challenge payloads during lookup by id", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const now = new Date("2026-07-12T12:00:00.000Z");
    const challenge = await store.createChallenge(now);

    redisClient.corruptPairingPayload(challenge.id);

    await expect(store.getById(challenge.id, now)).resolves.toBeNull();
    expect(companionPairingStoreMocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      {
        extra: { companionPairingId: challenge.id },
      },
    );
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
        now,
      }),
    ).resolves.toBeNull();
    expect(companionPairingStoreMocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      {
        extra: { companionPairingShortCode: challenge.shortCode },
      },
    );
  });

  it("reports corrupted Redis payloads during token issuance release", async () => {
    const redisClient = new FakeRedisClient();
    const store = new RedisCompanionPairingStore(async () => redisClient);
    const challenge = await store.createChallenge();
    await store.claimChallenge({ shortCode: challenge.shortCode, userId: "user-1" });
    redisClient.nextEvalResult = "{";

    await expect(
      store.releaseClaimedChallengeTokenIssuance({
        shortCode: challenge.shortCode,
        userId: "user-1",
      }),
    ).resolves.toBeNull();
    expect(companionPairingStoreMocks.mockCaptureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      {
        extra: { companionPairingShortCode: challenge.shortCode },
      },
    );
  });

  it("creates challenges through the shared Redis connection with Lua-capable clients", async () => {
    const redisClient = new FakeRedisClient();
    companionPairingStoreMocks.setSharedRedisClient(redisClient);
    companionPairingStoreMocks.mockRedisConnectionConstructor.mockClear();
    companionPairingStoreMocks.mockGetRedisConnection.mockClear();
    const store = new RedisCompanionPairingStore();
    const now = new Date("2026-07-12T12:00:00.000Z");

    await expect(store.createChallenge(now)).resolves.toMatchObject({
      shortCode: expect.stringMatching(PAIRING_SHORT_CODE_PATTERN),
    });

    expect(companionPairingStoreMocks.mockGetRedisConnection).toHaveBeenCalledOnce();
    expect(companionPairingStoreMocks.mockRedisConnectionConstructor).toHaveBeenCalledWith(
      companionPairingStoreMocks.queueConnection,
      {
        shared: true,
        blocking: false,
        skipVersionCheck: true,
      },
    );
  });

  it("fails loudly when the shared Redis connection lacks Lua eval support", async () => {
    const redisMethod = async (): Promise<null> => null;
    const invalidClients: unknown[] = [
      null,
      "redis",
      {},
      { get: redisMethod, del: redisMethod, eval: redisMethod },
      { set: redisMethod, del: redisMethod, eval: redisMethod },
      { set: redisMethod, get: redisMethod, eval: redisMethod },
      { set: redisMethod, get: redisMethod, del: redisMethod },
      { set: "set", get: redisMethod, del: redisMethod, eval: redisMethod },
      { set: redisMethod, get: "get", del: redisMethod, eval: redisMethod },
      { set: redisMethod, get: redisMethod, del: "del", eval: redisMethod },
      { set: redisMethod, get: redisMethod, del: redisMethod, eval: "eval" },
    ];
    const store = new RedisCompanionPairingStore();

    for (const invalidClient of invalidClients) {
      companionPairingStoreMocks.setSharedRedisClient(invalidClient);
      await expect(store.createChallenge()).rejects.toThrow(
        "Redis companion pairing store requires a Redis client with Lua eval support",
      );
    }
  });
});

describe("getCompanionPairingStore", () => {
  it("uses the in-memory store in tests", () => {
    expect(getCompanionPairingStore()).toBeInstanceOf(InMemoryCompanionPairingStore);
  });
});
