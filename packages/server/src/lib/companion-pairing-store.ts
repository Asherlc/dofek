import { randomBytes, randomInt } from "node:crypto";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import {
  type CompanionConnectionType,
  companionConnectionTypeSchema,
  DEFAULT_COMPANION_CONNECTION_TYPE,
} from "../companion/connection-type.ts";

export const COMPANION_PAIRING_TTL_MS = 10 * 60 * 1000;

const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SHORT_CODE_LENGTH = 6;
const PAIRING_HASH_TAG = "{companion-pairing}";
const PAIRING_KEY_PREFIX = `companion-pairing:${PAIRING_HASH_TAG}:challenge:`;
const PAIRING_CODE_KEY_PREFIX = `companion-pairing:${PAIRING_HASH_TAG}:code:`;
const CLAIM_ATTEMPT_KEY_PREFIX = "companion-pairing-claim-attempts:";
const CLAIM_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_ATTEMPT_LIMIT = 20;
const CREATE_CHALLENGE_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return 0
end
redis.call("PSETEX", KEYS[1], ARGV[3], ARGV[1])
redis.call("PSETEX", KEYS[2], ARGV[3], ARGV[2])
return 1
`;
const CLAIM_CHALLENGE_SCRIPT = `
local id = redis.call("GET", KEYS[1])
if not id or id ~= ARGV[1] then
  return nil
end

local payload = redis.call("GET", KEYS[2])
if not payload then
  redis.call("DEL", KEYS[1])
  return nil
end

local remainingTtlMs = redis.call("PTTL", KEYS[2])
if remainingTtlMs <= 0 then
  redis.call("DEL", KEYS[1], KEYS[2])
  return nil
end

local decodedOk, challenge = pcall(cjson.decode, payload)
if not decodedOk or type(challenge) ~= "table" then
  redis.call("DEL", KEYS[1], KEYS[2])
  return nil
end

if challenge["claimedAt"] ~= nil then
  if challenge["userId"] ~= ARGV[3] then
    return nil
  end
  if challenge["companionToken"] ~= nil or challenge["tokenIssuing"] == true then
    return nil
  end
end

challenge["claimedAt"] = ARGV[2]
challenge["userId"] = ARGV[3]
challenge["tokenIssuing"] = true
local updatedPayload = cjson.encode(challenge)
redis.call("PSETEX", KEYS[2], remainingTtlMs, updatedPayload)
redis.call("PEXPIRE", KEYS[1], remainingTtlMs)
return updatedPayload
`;
const SET_CLAIMED_CHALLENGE_TOKEN_SCRIPT = `
local id = redis.call("GET", KEYS[1])
if not id or id ~= ARGV[1] then
  return nil
end

local payload = redis.call("GET", KEYS[2])
if not payload then
  redis.call("DEL", KEYS[1])
  return nil
end

local remainingTtlMs = redis.call("PTTL", KEYS[2])
if remainingTtlMs <= 0 then
  redis.call("DEL", KEYS[1], KEYS[2])
  return nil
end

local decodedOk, challenge = pcall(cjson.decode, payload)
if not decodedOk or type(challenge) ~= "table" then
  redis.call("DEL", KEYS[1], KEYS[2])
  return nil
end

if challenge["claimedAt"] == nil or challenge["userId"] ~= ARGV[2] or challenge["tokenIssuing"] ~= true then
  return nil
end

if challenge["companionToken"] ~= nil then
  return payload
end

challenge["companionToken"] = ARGV[3]
challenge["tokenIssuing"] = nil
local updatedPayload = cjson.encode(challenge)
redis.call("PSETEX", KEYS[2], remainingTtlMs, updatedPayload)
redis.call("PEXPIRE", KEYS[1], remainingTtlMs)
return updatedPayload
`;
const RELEASE_CLAIMED_CHALLENGE_TOKEN_ISSUANCE_SCRIPT = `
local id = redis.call("GET", KEYS[1])
if not id or id ~= ARGV[1] then
  return nil
end

local payload = redis.call("GET", KEYS[2])
if not payload then
  redis.call("DEL", KEYS[1])
  return nil
end

local remainingTtlMs = redis.call("PTTL", KEYS[2])
if remainingTtlMs <= 0 then
  redis.call("DEL", KEYS[1], KEYS[2])
  return nil
end

local decodedOk, challenge = pcall(cjson.decode, payload)
if not decodedOk or type(challenge) ~= "table" then
  redis.call("DEL", KEYS[1], KEYS[2])
  return nil
end

if challenge["claimedAt"] == nil or challenge["userId"] ~= ARGV[2] or challenge["tokenIssuing"] ~= true or challenge["companionToken"] ~= nil then
  return nil
end

challenge["tokenIssuing"] = nil
local updatedPayload = cjson.encode(challenge)
redis.call("PSETEX", KEYS[2], remainingTtlMs, updatedPayload)
redis.call("PEXPIRE", KEYS[1], remainingTtlMs)
return updatedPayload
`;
const DELETE_CLAIMED_CHALLENGE_SCRIPT = `
local id = redis.call("GET", KEYS[1])
if not id or id ~= ARGV[1] then
  return 0
end

local payload = redis.call("GET", KEYS[2])
if not payload then
  redis.call("DEL", KEYS[1])
  return 0
end

local decodedOk, challenge = pcall(cjson.decode, payload)
if not decodedOk or type(challenge) ~= "table" then
  redis.call("DEL", KEYS[1], KEYS[2])
  return 0
end

if challenge["userId"] ~= ARGV[2] or challenge["companionToken"] ~= ARGV[3] then
  return 0
end

redis.call("DEL", KEYS[1], KEYS[2])
return 1
`;
const CONSUME_CLAIM_ATTEMPT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local remainingTtlMs = redis.call("PTTL", KEYS[1])
if remainingTtlMs < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count
`;

const companionPairingChallengeSchema = z.object({
  id: z.string(),
  shortCode: z.string(),
  connectionType: companionConnectionTypeSchema.default(DEFAULT_COMPANION_CONNECTION_TYPE),
  createdAt: z.string(),
  expiresAt: z.string(),
  claimedAt: z.string().optional(),
  userId: z.string().optional(),
  tokenIssuing: z.boolean().optional(),
  companionToken: z.string().optional(),
});

export type CompanionPairingChallenge = z.infer<typeof companionPairingChallengeSchema>;

export interface RedisClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
}

function isRedisClient(client: unknown): client is RedisClient {
  if (typeof client !== "object" || client === null) return false;
  return (
    "set" in client &&
    typeof client.set === "function" &&
    "get" in client &&
    typeof client.get === "function" &&
    "del" in client &&
    typeof client.del === "function" &&
    "eval" in client &&
    typeof client.eval === "function"
  );
}

export interface CompanionPairingStore {
  createChallenge(
    now?: Date,
    connectionType?: CompanionConnectionType,
  ): Promise<CompanionPairingChallenge>;
  getById(id: string, now?: Date): Promise<CompanionPairingChallenge | null>;
  getByShortCode(shortCode: string, now?: Date): Promise<CompanionPairingChallenge | null>;
  consumeClaimAttempt(userId: string, now?: Date): Promise<boolean>;
  claimChallenge(params: {
    shortCode: string;
    userId: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null>;
  setClaimedChallengeToken(params: {
    shortCode: string;
    userId: string;
    companionToken: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null>;
  releaseClaimedChallengeTokenIssuance(params: {
    shortCode: string;
    userId: string;
  }): Promise<CompanionPairingChallenge | null>;
  deleteClaimedChallenge(params: {
    shortCode: string;
    userId: string;
    companionToken: string;
  }): Promise<boolean>;
}

function pairingKey(id: string): string {
  return `${PAIRING_KEY_PREFIX}${id}`;
}

function pairingCodeKey(shortCode: string): string {
  return `${PAIRING_CODE_KEY_PREFIX}${shortCode}`;
}

function claimAttemptKey(userId: string): string {
  return `${CLAIM_ATTEMPT_KEY_PREFIX}${userId}`;
}

function ttlMs(challenge: CompanionPairingChallenge, now = new Date()): number {
  return new Date(challenge.expiresAt).getTime() - now.getTime();
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export const PAIRING_SHORT_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

export function generatePairingId(): string {
  return randomBytes(24).toString("base64url");
}

export function generateShortCode(): string {
  let code = "";
  for (let characterIndex = 0; characterIndex < SHORT_CODE_LENGTH; characterIndex += 1) {
    code += SHORT_CODE_ALPHABET.charAt(randomInt(SHORT_CODE_ALPHABET.length));
  }
  return code;
}

export function parsePairingCodeInput(code: string): string | null {
  const normalizedCode = normalizePairingCode(code);
  return PAIRING_SHORT_CODE_PATTERN.test(normalizedCode) ? normalizedCode : null;
}

function newChallenge(
  now = new Date(),
  connectionType: CompanionConnectionType = DEFAULT_COMPANION_CONNECTION_TYPE,
): CompanionPairingChallenge {
  return {
    id: generatePairingId(),
    shortCode: generateShortCode(),
    connectionType,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMPANION_PAIRING_TTL_MS).toISOString(),
  };
}

export class InMemoryCompanionPairingStore implements CompanionPairingStore {
  #byId = new Map<string, CompanionPairingChallenge>();
  #idByShortCode = new Map<string, string>();
  #claimAttemptsByUser = new Map<string, { count: number; resetsAt: number }>();

  async createChallenge(
    now = new Date(),
    connectionType: CompanionConnectionType = DEFAULT_COMPANION_CONNECTION_TYPE,
  ): Promise<CompanionPairingChallenge> {
    const challenge = newChallenge(now, connectionType);
    if (this.#idByShortCode.has(challenge.shortCode)) {
      throw new Error("Failed to allocate unique companion pairing code");
    }
    this.#save(challenge);
    return challenge;
  }

  async getById(id: string, now = new Date()): Promise<CompanionPairingChallenge | null> {
    const challenge = this.#byId.get(id);
    if (!challenge) return null;
    if (ttlMs(challenge, now) <= 0) {
      this.#delete(challenge);
      return null;
    }
    return challenge;
  }

  async getByShortCode(
    shortCode: string,
    now = new Date(),
  ): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const id = this.#idByShortCode.get(normalizedShortCode);
    if (!id) return null;
    return this.getById(id, now);
  }

  async consumeClaimAttempt(userId: string, now = new Date()): Promise<boolean> {
    this.#pruneExpiredClaimAttempts(now);
    const existing = this.#claimAttemptsByUser.get(userId);
    if (!existing || existing.resetsAt <= now.getTime()) {
      this.#claimAttemptsByUser.set(userId, {
        count: 1,
        resetsAt: now.getTime() + CLAIM_ATTEMPT_WINDOW_MS,
      });
      return true;
    }
    if (existing.count >= CLAIM_ATTEMPT_LIMIT) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  async claimChallenge({
    shortCode,
    userId,
    now = new Date(),
  }: {
    shortCode: string;
    userId: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const id = this.#idByShortCode.get(normalizedShortCode);
    const challenge = id ? this.#byId.get(id) : null;
    if (challenge && ttlMs(challenge, now) <= 0) {
      this.#delete(challenge);
      return null;
    }
    if (
      !challenge ||
      (challenge.claimedAt &&
        (challenge.userId !== userId || challenge.companionToken || challenge.tokenIssuing))
    ) {
      return null;
    }
    const claimedChallenge = {
      ...challenge,
      claimedAt: now.toISOString(),
      userId,
      tokenIssuing: true,
    };
    this.#save(claimedChallenge);
    return claimedChallenge;
  }

  async setClaimedChallengeToken({
    shortCode,
    userId,
    companionToken,
    now = new Date(),
  }: {
    shortCode: string;
    userId: string;
    companionToken: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null> {
    const challenge = await this.getByShortCode(shortCode, now);
    if (
      !challenge ||
      !challenge.claimedAt ||
      challenge.userId !== userId ||
      !challenge.tokenIssuing ||
      challenge.companionToken
    ) {
      return null;
    }
    const { tokenIssuing: _tokenIssuing, ...claimedChallenge } = challenge;
    const updatedChallenge = { ...claimedChallenge, companionToken };
    this.#save(updatedChallenge);
    return updatedChallenge;
  }

  async releaseClaimedChallengeTokenIssuance({
    shortCode,
    userId,
  }: {
    shortCode: string;
    userId: string;
  }): Promise<CompanionPairingChallenge | null> {
    const challenge = await this.getByShortCode(shortCode);
    if (
      !challenge ||
      !challenge.claimedAt ||
      challenge.userId !== userId ||
      !challenge.tokenIssuing ||
      challenge.companionToken
    ) {
      return null;
    }
    const { tokenIssuing: _tokenIssuing, ...releasedChallenge } = challenge;
    this.#save(releasedChallenge);
    return releasedChallenge;
  }

  async deleteClaimedChallenge({
    shortCode,
    userId,
    companionToken,
  }: {
    shortCode: string;
    userId: string;
    companionToken: string;
  }): Promise<boolean> {
    const challenge = await this.getByShortCode(shortCode);
    if (!challenge || challenge.userId !== userId || challenge.companionToken !== companionToken) {
      return false;
    }
    this.#delete(challenge);
    return true;
  }

  #save(challenge: CompanionPairingChallenge): void {
    this.#byId.set(challenge.id, challenge);
    this.#idByShortCode.set(challenge.shortCode, challenge.id);
  }

  #delete(challenge: CompanionPairingChallenge): void {
    this.#byId.delete(challenge.id);
    this.#idByShortCode.delete(challenge.shortCode);
  }

  #pruneExpiredClaimAttempts(now: Date): void {
    for (const [userId, userAttempts] of this.#claimAttemptsByUser) {
      if (userAttempts.resetsAt <= now.getTime()) {
        this.#claimAttemptsByUser.delete(userId);
      }
    }
  }
}

export class RedisCompanionPairingStore implements CompanionPairingStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async createChallenge(
    now = new Date(),
    connectionType: CompanionConnectionType = DEFAULT_COMPANION_CONNECTION_TYPE,
  ): Promise<CompanionPairingChallenge> {
    let challenge = newChallenge(now, connectionType);
    const client = await this.#getRedisClient();
    for (let attempt = 0; attempt < 5; attempt++) {
      const remainingTtlMs = Math.max(1, ttlMs(challenge, now));
      const created = await client.eval(
        CREATE_CHALLENGE_SCRIPT,
        2,
        pairingCodeKey(challenge.shortCode),
        pairingKey(challenge.id),
        challenge.id,
        JSON.stringify(challenge),
        String(remainingTtlMs),
      );
      if (created === 1) {
        return challenge;
      }
      challenge = newChallenge(now, connectionType);
    }
    throw new Error("Failed to allocate unique companion pairing code");
  }

  async getById(id: string, now = new Date()): Promise<CompanionPairingChallenge | null> {
    const client = await this.#getRedisClient();
    const payload = await client.get(pairingKey(id));
    if (!payload) return null;

    try {
      const parsed = companionPairingChallengeSchema.safeParse(JSON.parse(payload));
      if (!parsed.success || ttlMs(parsed.data, now) <= 0) {
        await client.del(pairingKey(id));
        return null;
      }
      return parsed.data;
    } catch (error) {
      captureException(error, { extra: { companionPairingId: id } });
      await client.del(pairingKey(id));
      return null;
    }
  }

  async getByShortCode(
    shortCode: string,
    now = new Date(),
  ): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const client = await this.#getRedisClient();
    const id = await client.get(pairingCodeKey(normalizedShortCode));
    if (!id) return null;
    return this.getById(id, now);
  }

  async consumeClaimAttempt(userId: string, _now?: Date): Promise<boolean> {
    // Redis key TTL is the source of truth for this window; callers cannot simulate time here.
    const client = await this.#getRedisClient();
    const attemptCount = await client.eval(
      CONSUME_CLAIM_ATTEMPT_SCRIPT,
      1,
      claimAttemptKey(userId),
      String(CLAIM_ATTEMPT_WINDOW_MS),
    );
    if (typeof attemptCount !== "number") {
      throw new Error("Redis companion pairing claim attempt limiter returned a non-numeric count");
    }
    return attemptCount <= CLAIM_ATTEMPT_LIMIT;
  }

  async claimChallenge({
    shortCode,
    userId,
    now = new Date(),
  }: {
    shortCode: string;
    userId: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const client = await this.#getRedisClient();
    const shortCodeKey = pairingCodeKey(normalizedShortCode);
    const id = await client.get(shortCodeKey);
    if (!id) return null;

    const payload = await client.eval(
      CLAIM_CHALLENGE_SCRIPT,
      2,
      shortCodeKey,
      pairingKey(id),
      id,
      now.toISOString(),
      userId,
    );
    if (typeof payload !== "string") {
      return null;
    }
    try {
      const parsed = companionPairingChallengeSchema.safeParse(JSON.parse(payload));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      captureException(error, { extra: { companionPairingShortCode: normalizedShortCode } });
      return null;
    }
  }

  async setClaimedChallengeToken({
    shortCode,
    userId,
    companionToken,
  }: {
    shortCode: string;
    userId: string;
    companionToken: string;
  }): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const client = await this.#getRedisClient();
    const shortCodeKey = pairingCodeKey(normalizedShortCode);
    const id = await client.get(shortCodeKey);
    if (!id) return null;

    const payload = await client.eval(
      SET_CLAIMED_CHALLENGE_TOKEN_SCRIPT,
      2,
      shortCodeKey,
      pairingKey(id),
      id,
      userId,
      companionToken,
    );
    if (typeof payload !== "string") return null;
    try {
      const parsed = companionPairingChallengeSchema.safeParse(JSON.parse(payload));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      captureException(error, { extra: { companionPairingShortCode: normalizedShortCode } });
      return null;
    }
  }

  async deleteClaimedChallenge({
    shortCode,
    userId,
    companionToken,
  }: {
    shortCode: string;
    userId: string;
    companionToken: string;
  }): Promise<boolean> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const client = await this.#getRedisClient();
    const shortCodeKey = pairingCodeKey(normalizedShortCode);
    const id = await client.get(shortCodeKey);
    if (!id) return false;
    const deleted = await client.eval(
      DELETE_CLAIMED_CHALLENGE_SCRIPT,
      2,
      shortCodeKey,
      pairingKey(id),
      id,
      userId,
      companionToken,
    );
    return deleted === 1;
  }

  async releaseClaimedChallengeTokenIssuance({
    shortCode,
    userId,
  }: {
    shortCode: string;
    userId: string;
  }): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const client = await this.#getRedisClient();
    const shortCodeKey = pairingCodeKey(normalizedShortCode);
    const id = await client.get(shortCodeKey);
    if (!id) return null;
    const payload = await client.eval(
      RELEASE_CLAIMED_CHALLENGE_TOKEN_ISSUANCE_SCRIPT,
      2,
      shortCodeKey,
      pairingKey(id),
      id,
      userId,
    );
    if (typeof payload !== "string") return null;
    try {
      const parsed = companionPairingChallengeSchema.safeParse(JSON.parse(payload));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      captureException(error, { extra: { companionPairingShortCode: normalizedShortCode } });
      return null;
    }
  }
}

let sharedRedisConnection: RedisConnection | null = null;

async function getSharedRedisClient(): Promise<RedisClient> {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  const client: unknown = await sharedRedisConnection.client;
  if (!isRedisClient(client)) {
    throw new Error("Redis companion pairing store requires a Redis client with Lua eval support");
  }
  return client;
}

const defaultCompanionPairingStore: CompanionPairingStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryCompanionPairingStore()
    : new RedisCompanionPairingStore();

export function getCompanionPairingStore(): CompanionPairingStore {
  return defaultCompanionPairingStore;
}
