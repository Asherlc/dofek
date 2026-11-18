import { randomUUID } from "node:crypto";
import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { RedisConnection } from "bullmq";
import { describe, expect, it } from "vitest";
import { RedisProviderRateLimitCooldownStore } from "./provider-rate-limit-cooldown.ts";
import { getRedisCommandConnection } from "./queues.ts";

describe("Redis provider cooldown concurrency", () => {
  it("retains the longest retry delay across concurrent provider-wide failures", async () => {
    const providerId = `cooldown-${randomUUID()}`;
    const connection = new RedisConnection(getRedisCommandConnection(), { blocking: false });
    const store = new RedisProviderRateLimitCooldownStore(() => connection.client);
    const redis = await connection.client;
    const startedAt = Date.now();

    try {
      await Promise.all([
        store.record(
          new ProviderServiceUnavailableError({
            message: "Service unavailable",
            providerId,
            statusCode: 503,
            responseBody: "",
            retryAfterSeconds: 600,
          }),
          "owner-1",
        ),
        store.record(
          new ProviderRateLimitError({
            message: "Rate limited",
            providerId,
            statusCode: 429,
            responseBody: "",
            retryAfterSeconds: 60,
          }),
          "owner-2",
        ),
      ]);

      const cooldown = await store.getActive(providerId, "owner-3");
      expect(cooldown).toMatchObject({ reason: "service_unavailable" });
      expect(cooldown?.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 600_000);
    } finally {
      await redis.del(`provider-rate-limit:${providerId}:provider`);
      await connection.close();
    }
  });
});
