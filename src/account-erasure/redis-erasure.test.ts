import { describe, expect, it } from "vitest";
import {
  type AccountRedisClient,
  type AccountRedisIdentifiers,
  purgeAccountRedisState,
} from "./redis-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const otherUserId = "20000000-0000-4000-8000-000000001994";
const identifiers: AccountRedisIdentifiers = {
  authIdentities: [
    {
      authProvider: "slack",
      providerAccountId: "U-ERASE",
    },
    {
      authProvider: "wahoo",
      providerAccountId: "wahoo-erased",
    },
  ],
  bullmqJobIds: ["job-erased"],
  sessionIds: ["session-erased"],
  uploadIds: ["40000000-0000-4000-8000-000000001994"],
  userId,
};

function globPatternMatches(value: string, pattern: string): boolean {
  let valueIndex = 0;
  let patternIndex = 0;
  let lastStarIndex = -1;
  let lastStarMatchIndex = 0;

  while (valueIndex < value.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === "?" || patternCharacter === value[valueIndex]) {
      valueIndex += 1;
      patternIndex += 1;
    } else if (patternCharacter === "*") {
      lastStarIndex = patternIndex;
      lastStarMatchIndex = valueIndex;
      patternIndex += 1;
    } else if (lastStarIndex !== -1) {
      patternIndex = lastStarIndex + 1;
      lastStarMatchIndex += 1;
      valueIndex = lastStarMatchIndex;
    } else {
      return false;
    }
  }

  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

class FakeRedis implements AccountRedisClient {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly streams = new Map<string, Array<[string, string[]]>>();
  aofEnabled = false;
  aofRewriteCount = 0;
  aofRewriteInProgress = false;
  deletedKeys = 0;
  rdbSaveCount = 4;
  rdbSaveInProgress = false;

  async bgrewriteaof(): Promise<string> {
    this.aofRewriteInProgress = true;
    this.aofRewriteCount += 1;
    this.aofRewriteInProgress = false;
    return "Background append only file rewriting started";
  }

  async bgsave(_schedule: "SCHEDULE"): Promise<string> {
    this.rdbSaveInProgress = true;
    this.rdbSaveCount += 1;
    this.rdbSaveInProgress = false;
    return "Background saving started";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
      if (this.streams.delete(key)) deleted += 1;
    }
    this.deletedKeys += deleted;
    return deleted;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async info(_section: "persistence"): Promise<string> {
    return [
      "# Persistence",
      `rdb_bgsave_in_progress:${this.rdbSaveInProgress ? 1 : 0}`,
      "rdb_last_bgsave_status:ok",
      `rdb_saves:${this.rdbSaveCount}`,
      `aof_enabled:${this.aofEnabled ? 1 : 0}`,
      `aof_rewrite_in_progress:${this.aofRewriteInProgress ? 1 : 0}`,
      "aof_rewrite_scheduled:0",
      "aof_last_bgrewrite_status:ok",
      "aof_last_write_status:ok",
      `aof_rewrites:${this.aofRewriteCount}`,
    ].join("\r\n");
  }

  async scan(
    cursor: string,
    _matchKeyword: "MATCH",
    pattern: string,
    _countKeyword: "COUNT",
    _count: string,
  ): Promise<[string, string[]]> {
    if (cursor !== "0") return ["0", []];
    const keys = [...new Set([...this.strings.keys(), ...this.sets.keys(), ...this.streams.keys()])]
      .filter((key) => globPatternMatches(key, pattern))
      .sort();
    return ["0", keys];
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const values = this.sets.get(key);
    if (!values) return 0;
    let removed = 0;
    for (const member of members) {
      if (values.delete(member)) removed += 1;
    }
    if (values.size === 0) this.sets.delete(key);
    return removed;
  }

  async type(key: string): Promise<string> {
    if (this.strings.has(key)) return "string";
    if (this.sets.has(key)) return "set";
    if (this.streams.has(key)) return "stream";
    return "none";
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    const entries = this.streams.get(key);
    if (!entries) return 0;
    const idSet = new Set(ids);
    const retained = entries.filter(([id]) => !idSet.has(id));
    this.streams.set(key, retained);
    return entries.length - retained.length;
  }

  async xrange(
    key: string,
    start: string,
    _end: string,
    _countKeyword: "COUNT",
    count: number,
  ): Promise<Array<[string, string[]]>> {
    const entries = this.streams.get(key) ?? [];
    const exclusiveStart = start.startsWith("(") ? start.slice(1) : null;
    const startIndex = exclusiveStart ? entries.findIndex(([id]) => id === exclusiveStart) + 1 : 0;
    return entries.slice(Math.max(0, startIndex), startIndex + count);
  }
}

function seedManagedState(redis: FakeRedis): void {
  redis.strings.set(
    "oauth-state:erased",
    JSON.stringify({
      providerId: "wahoo",
      intent: "data",
      userId,
    }),
  );
  redis.strings.set(
    "oauth-state:other",
    JSON.stringify({
      providerId: "wahoo",
      intent: "data",
      userId: otherUserId,
    }),
  );
  redis.strings.set(
    "oauth1-secret:erased",
    JSON.stringify({
      providerId: "fatsecret",
      tokenSecret: "secret",
      userId,
    }),
  );
  redis.strings.set(
    "identity-flow:erased",
    JSON.stringify({ codeVerifier: "verifier", linkUserId: userId }),
  );
  redis.strings.set(
    "mobile-auth-exchange:erased",
    JSON.stringify({
      kind: "session",
      sessionId: "session-erased",
      isNewUser: false,
    }),
  );
  redis.strings.set(
    "mobile-auth-exchange:other",
    JSON.stringify({
      kind: "session",
      sessionId: "session-other",
      isNewUser: false,
    }),
  );
  redis.strings.set(
    "pending-email-signup:erased",
    JSON.stringify({
      providerId: "wahoo",
      providerName: "Wahoo",
      identity: {
        providerAccountId: "wahoo-erased",
        email: null,
        name: null,
      },
      tokens: {
        accessToken: "secret",
        refreshToken: null,
        expiresAt: new Date().toISOString(),
        scopes: null,
      },
    }),
  );
  redis.strings.set("pending-email-signup-claim:erased", "claim-id");
  redis.strings.set(
    "companion-pairing:{companion-pairing}:challenge:pairing-erased",
    JSON.stringify({
      id: "pairing-erased",
      shortCode: "ABC234",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      claimedAt: new Date().toISOString(),
      userId,
    }),
  );
  redis.strings.set("companion-pairing:{companion-pairing}:code:ABC234", "pairing-erased");
  redis.strings.set(
    "whoop:verification:erased",
    JSON.stringify({
      session: "whoop-session",
      method: "sms",
      username: "private@example.test",
      expiresAt: Date.now() + 60_000,
      userId,
    }),
  );
  redis.strings.set(
    "slack:pending-entry:entry-erased",
    JSON.stringify({
      id: "30000000-0000-4000-8000-000000001994",
      userId,
      date: "2026-07-26",
      item: { name: "private meal" },
      channelId: "C1",
      confirmationMessageTs: "123.456",
      threadTs: "123.000",
      sourceMessageTs: "123.000",
      slackUserId: "U-ERASE",
    }),
  );
  redis.strings.set(
    "slack:pending-message:C1:123.456",
    JSON.stringify(["30000000-0000-4000-8000-000000001994"]),
  );
  redis.strings.set("slack:dedupe:action:confirm:T1:C1:123:a:U-ERASE", "1");
  redis.strings.set(
    "bull:post-sync:de:post-sync:user-refit:10000000-0000-4000-8000-000000001994",
    "job-erased",
  );
  redis.streams.set("bull:post-sync:events", [
    ["1-0", ["event", "waiting", "jobId", "job-erased"]],
    ["2-0", ["event", "waiting", "jobId", "job-other"]],
  ]);
  redis.strings.set(
    "upload-session:40000000-0000-4000-8000-000000001994",
    JSON.stringify({ total: 10, dir: "/jobs/private", userId }),
  );
  redis.sets.set("upload-chunks:40000000-0000-4000-8000-000000001994", new Set(["0"]));
  redis.strings.set(
    "upload-chunk-bytes:40000000-0000-4000-8000-000000001994",
    "opaque-hash-for-test",
  );
  redis.strings.set(
    "upload-status:40000000-0000-4000-8000-000000001994",
    JSON.stringify({
      status: "processing",
      progress: 50,
      message: "private filename",
      userId,
    }),
  );
  redis.strings.set(`companion-pairing-claim-attempts:${userId}`, "1");
  redis.strings.set(`provider-rate-limit:garmin:user:${userId}`, "{}");
  redis.strings.set(`provider-adaptive-rate:garmin:user:${userId}`, "{}");
  const userCacheKey = `query-cache:data:${userId}:dashboard:{}`;
  const otherCacheKey = `query-cache:data:${otherUserId}:dashboard:{}`;
  redis.strings.set(userCacheKey, JSON.stringify({ isPrivate: true }));
  redis.strings.set(otherCacheKey, JSON.stringify({ isPrivate: false }));
  redis.sets.set("query-cache:keys", new Set([userCacheKey, otherCacheKey]));
}

describe("purgeAccountRedisState", () => {
  it("removes every managed user-owned key, its indexes, and exact keyed state", async () => {
    const redis = new FakeRedis();
    seedManagedState(redis);

    const result = await purgeAccountRedisState(identifiers, redis, {
      sleep: async () => undefined,
    });

    expect(result.deletedKeys).toBeGreaterThan(0);
    expect(result.deletedStreamEntries).toBe(1);
    expect(result.removedSetMembers).toBe(1);
    expect(result.rdbPersisted).toBe(true);
    expect(result.aofPersisted).toBe(false);
    expect(redis.rdbSaveCount).toBe(5);
    expect([...redis.strings.keys()].sort()).toEqual(
      [
        "mobile-auth-exchange:other",
        "oauth-state:other",
        `query-cache:data:${otherUserId}:dashboard:{}`,
      ].sort(),
    );
    expect([...(redis.sets.get("query-cache:keys") ?? [])]).toEqual([
      `query-cache:data:${otherUserId}:dashboard:{}`,
    ]);
    expect(redis.streams.get("bull:post-sync:events")).toEqual([
      ["2-0", ["event", "waiting", "jobId", "job-other"]],
    ]);
  });

  it("keeps a pending signup whose provider differs despite a colliding account ID", async () => {
    const redis = new FakeRedis();
    redis.strings.set(
      "pending-email-signup:other-provider",
      JSON.stringify({
        providerId: "strava",
        providerName: "Strava",
        identity: {
          providerAccountId: "wahoo-erased",
          email: null,
          name: null,
        },
        tokens: {
          accessToken: "other-secret",
          refreshToken: null,
          expiresAt: new Date().toISOString(),
          scopes: null,
        },
      }),
    );
    redis.strings.set("pending-email-signup-claim:other-provider", "other-claim");

    await purgeAccountRedisState(identifiers, redis, {
      sleep: async () => undefined,
    });

    expect(redis.strings.has("pending-email-signup:other-provider")).toBe(true);
    expect(redis.strings.has("pending-email-signup-claim:other-provider")).toBe(true);
  });

  it("rewrites both RDB and AOF persistence after mutations when AOF is enabled", async () => {
    const redis = new FakeRedis();
    redis.aofEnabled = true;
    redis.strings.set(`provider-rate-limit:garmin:user:${userId}`, "{}");

    const result = await purgeAccountRedisState(identifiers, redis, {
      sleep: async () => undefined,
    });

    expect(result.aofPersisted).toBe(true);
    expect(result.rdbPersisted).toBe(true);
    expect(redis.aofRewriteCount).toBe(1);
    expect(redis.rdbSaveCount).toBe(5);
  });

  it("persists an empty verification pass", async () => {
    const redis = new FakeRedis();

    const result = await purgeAccountRedisState(identifiers, redis, {
      sleep: async () => undefined,
    });

    expect(result).toEqual({
      aofPersisted: false,
      deletedKeys: 0,
      deletedStreamEntries: 0,
      rdbPersisted: true,
      removedSetMembers: 0,
      scanPasses: 1,
    });
    expect(redis.rdbSaveCount).toBe(5);
  });

  it("persists deletion on retry after a crash between logical deletion and persistence", async () => {
    class CrashBeforePersistenceRedis extends FakeRedis {
      crashBeforePersistence = true;

      override async info(section: "persistence"): Promise<string> {
        if (this.crashBeforePersistence && this.deletedKeys > 0) {
          this.crashBeforePersistence = false;
          throw new Error("simulated process crash before Redis persistence");
        }
        return super.info(section);
      }
    }
    const redis = new CrashBeforePersistenceRedis();
    redis.strings.set(`provider-rate-limit:garmin:user:${userId}`, "{}");

    await expect(
      purgeAccountRedisState(identifiers, redis, {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("simulated process crash before Redis persistence");
    expect(redis.strings.size).toBe(0);
    expect(redis.rdbSaveCount).toBe(4);

    const retryResult = await purgeAccountRedisState(identifiers, redis, {
      sleep: async () => undefined,
    });

    expect(retryResult.deletedKeys).toBe(0);
    expect(retryResult.rdbPersisted).toBe(true);
    expect(redis.rdbSaveCount).toBe(5);
  });

  it("fails closed when a managed payload cannot be parsed", async () => {
    const redis = new FakeRedis();
    redis.strings.set("oauth-state:malformed", "{");

    await expect(
      purgeAccountRedisState(identifiers, redis, {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(
      "Account erasure cannot prove ownership of malformed oauth-state Redis state",
    );
    expect(redis.strings.has("oauth-state:malformed")).toBe(true);
  });

  it("fails when a managed prefix has an unexpected Redis data type", async () => {
    const redis = new FakeRedis();
    redis.sets.set("whoop:verification:unexpected", new Set(["private"]));

    await expect(
      purgeAccountRedisState(identifiers, redis, {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(
      "Account erasure expected string values in the whoop-verification Redis namespace",
    );
  });

  it("fails if persistence reports an unsuccessful background operation", async () => {
    class FailedSaveRedis extends FakeRedis {
      override async info(section: "persistence"): Promise<string> {
        const info = await super.info(section);
        return info.replace("rdb_last_bgsave_status:ok", "rdb_last_bgsave_status:err");
      }
    }
    const redis = new FailedSaveRedis();
    redis.strings.set(`provider-rate-limit:garmin:user:${userId}`, "{}");

    await expect(
      purgeAccountRedisState(identifiers, redis, {
        persistencePollLimit: 1,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("Redis RDB persistence did not complete successfully");
  });
});
