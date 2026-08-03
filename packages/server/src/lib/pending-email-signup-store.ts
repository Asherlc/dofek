import { randomBytes } from "node:crypto";
import { RedisConnection } from "bullmq";
import type { TokenSet } from "dofek/auth/oauth";
import { getRedisConnection } from "dofek/jobs/queues";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";

const ENTRY_TTL_MS = 10 * 60 * 1000;
const CLAIM_TTL_MS = 60 * 1000;
const ENTRY_PREFIX = "pending-email-signup:";
const CLAIM_PREFIX = "pending-email-signup-claim:";
const ISSUE_FAILURE_MESSAGE = "Failed to store pending email signup";

const tokenSetSchema: z.ZodType<TokenSet> = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.coerce.date(),
  scopes: z.string().nullable(),
});

const pendingEmailSignupEntrySchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  apiBaseUrl: z.string().optional(),
  identity: z.object({
    providerAccountId: z.string(),
    email: z.null(),
    name: z.string().nullable(),
  }),
  tokens: tokenSetSchema,
  mobileScheme: z.string().optional(),
  returnTo: z.string().optional(),
});

export type PendingEmailSignupEntry = z.infer<typeof pendingEmailSignupEntrySchema>;

export interface PendingEmailSignupClaim {
  token: string;
  claimId: string;
  entry: PendingEmailSignupEntry;
}

export interface PendingEmailSignupStore {
  issue(entry: PendingEmailSignupEntry): Promise<string>;
  get(token: string): Promise<PendingEmailSignupEntry | null>;
  claim(token: string): Promise<PendingEmailSignupClaim | null>;
  renew(claim: PendingEmailSignupClaim): Promise<void>;
  release(claim: PendingEmailSignupClaim): Promise<void>;
  complete(claim: PendingEmailSignupClaim): Promise<void>;
}

interface InMemoryEntry {
  entry: PendingEmailSignupEntry;
  expiresAt: number;
}

interface InMemoryClaim {
  claimId: string;
  expiresAt: number;
}

export class InMemoryPendingEmailSignupStore implements PendingEmailSignupStore {
  readonly #entries = new Map<string, InMemoryEntry>();
  readonly #claims = new Map<string, InMemoryClaim>();
  readonly #entryTtlMs: number;
  readonly #claimTtlMs: number;

  constructor(options: { entryTtlMs?: number; claimTtlMs?: number } = {}) {
    this.#entryTtlMs = options.entryTtlMs ?? ENTRY_TTL_MS;
    this.#claimTtlMs = options.claimTtlMs ?? CLAIM_TTL_MS;
  }

  async issue(entry: PendingEmailSignupEntry): Promise<string> {
    const token = randomBytes(16).toString("hex");
    this.#entries.set(token, {
      entry,
      expiresAt: Date.now() + this.#entryTtlMs,
    });
    return token;
  }

  async get(token: string): Promise<PendingEmailSignupEntry | null> {
    const stored = this.#entries.get(token);
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      this.#entries.delete(token);
      return null;
    }
    return stored.entry;
  }

  async claim(token: string): Promise<PendingEmailSignupClaim | null> {
    const entry = await this.get(token);
    if (!entry) return null;

    const now = Date.now();
    const existingClaim = this.#claims.get(token);
    if (existingClaim && existingClaim.expiresAt > now) return null;

    const claimId = randomBytes(16).toString("hex");
    this.#claims.set(token, {
      claimId,
      expiresAt: now + this.#claimTtlMs,
    });
    return { token, claimId, entry };
  }

  async release(claim: PendingEmailSignupClaim): Promise<void> {
    if (this.#ownsClaim(claim)) {
      this.#claims.delete(claim.token);
    }
  }

  async renew(claim: PendingEmailSignupClaim): Promise<void> {
    const storedClaim = this.#claims.get(claim.token);
    if (storedClaim?.claimId !== claim.claimId || storedClaim.expiresAt <= Date.now()) {
      throw new Error("Pending email signup claim is no longer owned");
    }
    storedClaim.expiresAt = Date.now() + this.#claimTtlMs;
  }

  async complete(claim: PendingEmailSignupClaim): Promise<void> {
    if (!this.#ownsClaim(claim)) {
      throw new Error("Pending email signup claim is no longer owned");
    }
    this.#claims.delete(claim.token);
    this.#entries.delete(claim.token);
  }

  #ownsClaim(claim: PendingEmailSignupClaim): boolean {
    const storedClaim = this.#claims.get(claim.token);
    return storedClaim?.claimId === claim.claimId && storedClaim.expiresAt > Date.now();
  }
}

interface RedisCommandClient {
  sendCommand(command: string[]): Promise<unknown>;
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

function entryKey(token: string): string {
  return `${ENTRY_PREFIX}${token}`;
}

function claimKey(token: string): string {
  return `${CLAIM_PREFIX}${token}`;
}

function isRedisCommandClient(value: unknown): value is RedisCommandClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "sendCommand" in value &&
    typeof value.sendCommand === "function"
  );
}

let sharedRedisConnection: RedisConnection | null = null;

async function getSharedRedisClient(): Promise<RedisCommandClient> {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  const client: unknown = await sharedRedisConnection.client;
  if (!isRedisCommandClient(client)) {
    throw new Error("Redis client does not support pending email signup commands");
  }
  return client;
}

export class RedisPendingEmailSignupStore implements PendingEmailSignupStore {
  readonly #getRedisClient: () => Promise<RedisCommandClient>;

  constructor(getRedisClient: () => Promise<RedisCommandClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async issue(entry: PendingEmailSignupEntry): Promise<string> {
    const token = randomBytes(16).toString("hex");
    const client = await this.#getRedisClient();
    const command = ["SET", entryKey(token), JSON.stringify(entry), "PX", `${ENTRY_TTL_MS}`];
    let result: unknown;
    try {
      result = await client.sendCommand(command);
    } catch {
      throw new Error(ISSUE_FAILURE_MESSAGE);
    }
    if (result !== "OK") {
      throw new Error(ISSUE_FAILURE_MESSAGE);
    }
    return token;
  }

  async get(token: string): Promise<PendingEmailSignupEntry | null> {
    const client = await this.#getRedisClient();
    const payload = await client.sendCommand(["GET", entryKey(token)]);
    if (typeof payload !== "string") return null;

    let decoded: unknown;
    try {
      decoded = JSON.parse(payload);
    } catch {
      captureException(new Error("Invalid pending email signup Redis payload"), {
        tags: {
          context: "pending-email-signup-parse",
          reason: "json",
        },
      });
      await client.sendCommand(["DEL", entryKey(token)]);
      return null;
    }

    const parsed = pendingEmailSignupEntrySchema.safeParse(decoded);
    if (!parsed.success) {
      captureException(new Error("Invalid pending email signup Redis payload"), {
        tags: {
          context: "pending-email-signup-parse",
          reason: "schema",
        },
      });
      await client.sendCommand(["DEL", entryKey(token)]);
      return null;
    }
    return parsed.data;
  }

  async claim(token: string): Promise<PendingEmailSignupClaim | null> {
    const client = await this.#getRedisClient();
    const claimId = randomBytes(16).toString("hex");
    const result = await client.sendCommand([
      "SET",
      claimKey(token),
      claimId,
      "NX",
      "PX",
      `${CLAIM_TTL_MS}`,
    ]);
    if (result !== "OK") return null;

    const entry = await this.get(token);
    if (!entry) {
      await this.#release(token, claimId);
      return null;
    }
    return { token, claimId, entry };
  }

  async release(claim: PendingEmailSignupClaim): Promise<void> {
    await this.#release(claim.token, claim.claimId);
  }

  async renew(claim: PendingEmailSignupClaim): Promise<void> {
    const client = await this.#getRedisClient();
    const result = await client.sendCommand([
      "EVAL",
      RENEW_CLAIM_SCRIPT,
      "1",
      claimKey(claim.token),
      claim.claimId,
      `${CLAIM_TTL_MS}`,
    ]);
    if (result !== 1) {
      throw new Error("Pending email signup claim is no longer owned");
    }
  }

  async #release(token: string, claimId: string): Promise<void> {
    const client = await this.#getRedisClient();
    await client.sendCommand(["EVAL", RELEASE_CLAIM_SCRIPT, "1", claimKey(token), claimId]);
  }

  async complete(claim: PendingEmailSignupClaim): Promise<void> {
    const client = await this.#getRedisClient();
    const result = await client.sendCommand([
      "EVAL",
      COMPLETE_CLAIM_SCRIPT,
      "2",
      claimKey(claim.token),
      entryKey(claim.token),
      claim.claimId,
    ]);
    if (result !== 1) {
      throw new Error("Pending email signup claim is no longer owned");
    }
  }
}

const defaultStore: PendingEmailSignupStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryPendingEmailSignupStore()
    : new RedisPendingEmailSignupStore();

export function getPendingEmailSignupStore(): PendingEmailSignupStore {
  return defaultStore;
}
