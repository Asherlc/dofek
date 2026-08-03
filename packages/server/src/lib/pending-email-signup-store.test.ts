import { captureException } from "dofek/lib/error-reporting";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPendingEmailSignupStore,
  InMemoryPendingEmailSignupStore,
  type PendingEmailSignupEntry,
  RedisPendingEmailSignupStore,
} from "./pending-email-signup-store.ts";

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

interface FakeRedisEntry {
  value: string;
  expiresAt: number | null;
}

const RELEASE_CLAIM_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const RENEW_CLAIM_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const COMPLETE_CLAIM_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  redis.call("del", KEYS[2])
  return redis.call("del", KEYS[1])
end
return 0
`;

class FakeRedisCommandClient {
  readonly commands: string[][] = [];
  readonly #entries = new Map<string, FakeRedisEntry>();
  nextSetResult: "OK" | null = "OK";

  async sendCommand(command: string[]): Promise<unknown> {
    this.commands.push(command);
    const operation = command[0];

    if (operation === "SET") {
      return this.#set(command);
    }
    if (operation === "GET") {
      return this.#get(command[1]);
    }
    if (operation === "DEL") {
      return this.#delete(command.slice(1));
    }
    if (operation === "EVAL") {
      return this.#evaluate(command);
    }
    throw new Error(`Unsupported Redis command: ${operation}`);
  }

  #set(command: string[]): "OK" | null {
    const [, key, value, ...options] = command;
    if (!key || value === undefined) throw new Error("Invalid SET command");
    const nx = options.includes("NX");
    const pxIndex = options.indexOf("PX");
    const ttl = pxIndex === -1 ? null : Number(options[pxIndex + 1]);
    if (nx && this.#get(key) !== null) return null;
    if (this.nextSetResult === null) {
      this.nextSetResult = "OK";
      return null;
    }
    this.#entries.set(key, {
      value,
      expiresAt: ttl === null ? null : Date.now() + ttl,
    });
    return "OK";
  }

  write(key: string, value: string, ttl = 600_000): void {
    this.#entries.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
  }

  #get(key: string | undefined): string | null {
    if (!key) throw new Error("Missing Redis key");
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  #delete(keys: string[]): number {
    let deleted = 0;
    for (const key of keys) {
      if (this.#entries.delete(key)) deleted += 1;
    }
    return deleted;
  }

  #evaluate(command: string[]): number {
    const [, script, keyCountValue, ...keysAndArguments] = command;
    const keyCount = Number(keyCountValue);
    const keys = keysAndArguments.slice(0, keyCount);
    const arguments_ = keysAndArguments.slice(keyCount);
    const claimKey = keys[0];
    const claimId = arguments_[0];
    if (!script || !claimKey || !claimId) throw new Error("Invalid EVAL command");
    if (
      script !== RELEASE_CLAIM_SCRIPT &&
      script !== RENEW_CLAIM_SCRIPT &&
      script !== COMPLETE_CLAIM_SCRIPT
    ) {
      throw new Error("Unsupported EVAL script");
    }
    if (
      ((script === RELEASE_CLAIM_SCRIPT || script === RENEW_CLAIM_SCRIPT) && keyCount !== 1) ||
      (script === COMPLETE_CLAIM_SCRIPT && keyCount !== 2)
    ) {
      throw new Error("Invalid EVAL key count");
    }
    if (this.#get(claimKey) !== claimId) return 0;
    if (script === RENEW_CLAIM_SCRIPT) {
      const ttl = Number(arguments_[1]);
      const entry = this.#entries.get(claimKey);
      if (!entry || !Number.isFinite(ttl)) throw new Error("Invalid PEXPIRE command");
      entry.expiresAt = Date.now() + ttl;
      return 1;
    }
    if (keyCount === 2) {
      const entryKey = keys[1];
      if (!entryKey) throw new Error("Missing entry key");
      this.#delete([entryKey]);
    }
    return this.#delete([claimKey]);
  }
}

const sampleEntry: PendingEmailSignupEntry = {
  providerId: "strava",
  providerName: "Strava",
  identity: {
    providerAccountId: "provider-account-1",
    email: null,
    name: "Runner",
  },
  tokens: {
    accessToken: "access-token",
    refreshToken: null,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    scopes: null,
  },
  returnTo: "/settings",
};

beforeEach(() => {
  vi.mocked(captureException).mockClear();
});

describe("RedisPendingEmailSignupStore", () => {
  it("shares a pending signup across Redis store instances and completes it once", async () => {
    const client = new FakeRedisCommandClient();
    const callbackStore = new RedisPendingEmailSignupStore(async () => client);
    const completionStore = new RedisPendingEmailSignupStore(async () => client);

    const token = await callbackStore.issue(sampleEntry);
    expect(await completionStore.get(token)).toEqual(sampleEntry);

    const claim = await completionStore.claim(token);
    expect(claim?.entry).toEqual(sampleEntry);
    if (!claim) throw new Error("Expected completion claim");

    await completionStore.complete(claim);
    await expect(callbackStore.get(token)).resolves.toBeNull();
    await expect(callbackStore.claim(token)).resolves.toBeNull();
  });

  it("completes an owned claim after the pending entry expires", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeRedisCommandClient();
      const store = new RedisPendingEmailSignupStore(async () => client);
      const token = await store.issue(sampleEntry);

      vi.advanceTimersByTime(599_999);
      const claim = await store.claim(token);
      if (!claim) throw new Error("Expected completion claim");
      vi.advanceTimersByTime(2);
      await expect(store.get(token)).resolves.toBeNull();

      await expect(store.complete(claim)).resolves.toBeUndefined();
      await expect(store.claim(token)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores entries with a ten-minute TTL", async () => {
    const client = new FakeRedisCommandClient();
    const store = new RedisPendingEmailSignupStore(async () => client);

    await store.issue(sampleEntry);

    expect(client.commands[0]).toEqual([
      "SET",
      expect.stringMatching(/^pending-email-signup:[a-f0-9]{32}$/),
      expect.any(String),
      "PX",
      "600000",
    ]);
  });

  it("throws when Redis does not store an issued entry", async () => {
    const client = new FakeRedisCommandClient();
    client.nextSetResult = null;
    const store = new RedisPendingEmailSignupStore(async () => client);

    await expect(store.issue(sampleEntry)).rejects.toThrow("Failed to store pending email signup");
  });

  it("sanitizes Redis command failures when issuing an entry", async () => {
    const accessTokenFragment = "secret-access-fragment";
    const refreshTokenFragment = "secret-refresh-fragment";
    const redisError = new Error(
      `SET failed for ${accessTokenFragment} and ${refreshTokenFragment}`,
    );
    const client = {
      sendCommand: vi.fn().mockRejectedValue(redisError),
    };
    const store = new RedisPendingEmailSignupStore(async () => client);
    const entry: PendingEmailSignupEntry = {
      ...sampleEntry,
      tokens: {
        ...sampleEntry.tokens,
        accessToken: accessTokenFragment,
        refreshToken: refreshTokenFragment,
      },
    };

    const rejection = await store.issue(entry).catch((error: unknown) => error);

    expect(rejection).toEqual(new Error("Failed to store pending email signup"));
    expect(rejection).not.toBe(redisError);
    expect(rejection).not.toHaveProperty("cause");
    const reportingArguments = [
      [rejection],
      [
        `[auth] OAuth callback failed: ${
          rejection instanceof Error ? rejection.message : String(rejection)
        }`,
        { err: rejection },
      ],
    ];
    const reportingArgumentsText = reportingArguments
      .flatMap((args) =>
        args.map((argument) =>
          argument instanceof Error
            ? `${argument.name}: ${argument.message}`
            : JSON.stringify(argument),
        ),
      )
      .join("\n");
    expect(reportingArgumentsText).not.toContain(accessTokenFragment);
    expect(reportingArgumentsText).not.toContain(refreshTokenFragment);
  });

  it("allows only one simultaneous claim", async () => {
    const client = new FakeRedisCommandClient();
    const store = new RedisPendingEmailSignupStore(async () => client);
    const token = await store.issue(sampleEntry);

    const claims = await Promise.all([store.claim(token), store.claim(token)]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  it("releases a claim without rewriting or extending the entry", async () => {
    const client = new FakeRedisCommandClient();
    const store = new RedisPendingEmailSignupStore(async () => client);
    const token = await store.issue(sampleEntry);
    const firstClaim = await store.claim(token);
    if (!firstClaim) throw new Error("Expected first claim");

    await store.release(firstClaim);
    const secondClaim = await store.claim(token);

    expect(secondClaim?.entry).toEqual(sampleEntry);
    expect(
      client.commands.filter(
        (command) => command[0] === "SET" && command[1]?.startsWith("pending-email-signup:"),
      ),
    ).toHaveLength(1);
  });

  it("prevents a stale owner from releasing or completing a newer claim", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeRedisCommandClient();
      const store = new RedisPendingEmailSignupStore(async () => client);
      const token = await store.issue(sampleEntry);
      const staleClaim = await store.claim(token);
      if (!staleClaim) throw new Error("Expected stale claim");

      vi.advanceTimersByTime(60_001);
      const currentClaim = await store.claim(token);
      if (!currentClaim) throw new Error("Expected current claim");

      await store.release(staleClaim);
      await expect(store.claim(token)).resolves.toBeNull();
      await expect(store.complete(staleClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );
      await store.complete(currentClaim);
      await expect(store.get(token)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews an owned claim across its original 60-second expiry", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeRedisCommandClient();
      const store = new RedisPendingEmailSignupStore(async () => client);
      const token = await store.issue(sampleEntry);
      const claim = await store.claim(token);
      if (!claim) throw new Error("Expected claim");

      vi.advanceTimersByTime(40_000);
      await store.renew(claim);
      vi.advanceTimersByTime(20_001);

      await expect(store.claim(token)).resolves.toBeNull();
      expect(client.commands).toContainEqual([
        "EVAL",
        RENEW_CLAIM_SCRIPT,
        "1",
        expect.stringMatching(/^pending-email-signup-claim:[a-f0-9]{32}$/),
        claim.claimId,
        "60000",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects renewal from an expired or stale owner", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeRedisCommandClient();
      const store = new RedisPendingEmailSignupStore(async () => client);
      const token = await store.issue(sampleEntry);
      const staleClaim = await store.claim(token);
      if (!staleClaim) throw new Error("Expected stale claim");

      vi.advanceTimersByTime(60_001);
      await expect(store.renew(staleClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );

      const currentClaim = await store.claim(token);
      if (!currentClaim) throw new Error("Expected current claim");
      await expect(store.renew(staleClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes and reports malformed JSON without exposing credentials", async () => {
    const client = new FakeRedisCommandClient();
    const store = new RedisPendingEmailSignupStore(async () => client);
    const token = await store.issue(sampleEntry);
    const credentialFragment = "credential-json-fragment";
    client.write(`pending-email-signup:${token}`, `{"accessToken":"${credentialFragment}"`);

    await expect(store.get(token)).resolves.toBeNull();

    expect(captureException).toHaveBeenCalledWith(
      new Error("Invalid pending email signup Redis payload"),
      {
        tags: {
          context: "pending-email-signup-parse",
          reason: "json",
        },
      },
    );
    expect(await store.get(token)).toBeNull();
    const sentryCallText = vi
      .mocked(captureException)
      .mock.calls.map(([error, context]) => `${String(error)} ${JSON.stringify(context)}`)
      .join("\n");
    expect(sentryCallText).not.toContain(credentialFragment);
    expect(sentryCallText).not.toContain(sampleEntry.tokens.accessToken);
  });

  it("deletes and reports schema-invalid JSON without exposing credentials", async () => {
    const client = new FakeRedisCommandClient();
    const store = new RedisPendingEmailSignupStore(async () => client);
    const token = await store.issue(sampleEntry);
    const credentialFragment = "credential-schema-fragment";
    client.write(
      `pending-email-signup:${token}`,
      JSON.stringify({ tokens: { accessToken: credentialFragment } }),
    );

    await expect(store.get(token)).resolves.toBeNull();

    expect(captureException).toHaveBeenCalledWith(
      new Error("Invalid pending email signup Redis payload"),
      {
        tags: {
          context: "pending-email-signup-parse",
          reason: "schema",
        },
      },
    );
    expect(await store.get(token)).toBeNull();
    const sentryCallText = vi
      .mocked(captureException)
      .mock.calls.map(([error, context]) => `${String(error)} ${JSON.stringify(context)}`)
      .join("\n");
    expect(sentryCallText).not.toContain(credentialFragment);
    expect(sentryCallText).not.toContain(sampleEntry.tokens.accessToken);
  });
});

describe("InMemoryPendingEmailSignupStore", () => {
  it("rejects expired entries", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPendingEmailSignupStore({
        entryTtlMs: 1,
        claimTtlMs: 1,
      });
      const token = await store.issue(sampleEntry);

      vi.advanceTimersByTime(2);

      await expect(store.get(token)).resolves.toBeNull();
      await expect(store.claim(token)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects completion after the claim lease expires", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPendingEmailSignupStore({ claimTtlMs: 1 });
      const token = await store.issue(sampleEntry);
      const expiredClaim = await store.claim(token);
      if (!expiredClaim) throw new Error("Expected expiring claim");

      vi.advanceTimersByTime(2);

      await expect(store.complete(expiredClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );
      await expect(store.get(token)).resolves.toEqual(sampleEntry);

      await store.release(expiredClaim);
      const currentClaim = await store.claim(token);
      expect(currentClaim?.entry).toEqual(sampleEntry);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews an owned claim across its original expiry", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPendingEmailSignupStore({ claimTtlMs: 60_000 });
      const token = await store.issue(sampleEntry);
      const claim = await store.claim(token);
      if (!claim) throw new Error("Expected claim");

      vi.advanceTimersByTime(40_000);
      await store.renew(claim);
      vi.advanceTimersByTime(20_001);

      await expect(store.claim(token)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects renewal after expiry and from a stale owner", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPendingEmailSignupStore({ claimTtlMs: 1 });
      const token = await store.issue(sampleEntry);
      const staleClaim = await store.claim(token);
      if (!staleClaim) throw new Error("Expected stale claim");

      vi.advanceTimersByTime(2);
      await expect(store.renew(staleClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );

      const currentClaim = await store.claim(token);
      if (!currentClaim) throw new Error("Expected current claim");
      await expect(store.renew(staleClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents a stale owner from releasing or completing a newer claim", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPendingEmailSignupStore({ claimTtlMs: 1 });
      const token = await store.issue(sampleEntry);
      const staleClaim = await store.claim(token);
      if (!staleClaim) throw new Error("Expected stale claim");
      vi.advanceTimersByTime(2);
      const currentClaim = await store.claim(token);
      if (!currentClaim) throw new Error("Expected current claim");

      await store.release(staleClaim);
      await expect(store.claim(token)).resolves.toBeNull();
      await expect(store.complete(staleClaim)).rejects.toThrow(
        "Pending email signup claim is no longer owned",
      );
      await store.complete(currentClaim);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getPendingEmailSignupStore", () => {
  it("returns an in-memory store in tests", () => {
    expect(getPendingEmailSignupStore()).toBeInstanceOf(InMemoryPendingEmailSignupStore);
  });

  it("returns a Redis store outside tests", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const client = new FakeRedisCommandClient();

    class MockRedisConnection {
      readonly client = Promise.resolve(client);
    }

    process.env.NODE_ENV = "production";
    vi.resetModules();
    vi.doMock("bullmq", () => ({ RedisConnection: MockRedisConnection }));
    vi.doMock("dofek/jobs/queues", () => ({
      getRedisConnection: vi.fn(() => ({ host: "localhost", port: 6379 })),
    }));

    try {
      const module = await import("./pending-email-signup-store.ts");
      const store = module.getPendingEmailSignupStore();
      expect(store).toBeInstanceOf(module.RedisPendingEmailSignupStore);
      await expect(store.issue(sampleEntry)).resolves.toMatch(/^[a-f0-9]{32}$/);
    } finally {
      vi.resetModules();
      vi.doUnmock("bullmq");
      vi.doUnmock("dofek/jobs/queues");
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
