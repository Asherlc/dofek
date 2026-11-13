import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

describe("process queue resource cleanup", () => {
  it("closes the registry and router Redis clients and exits naturally after work drains", async () => {
    if (!process.env.REDIS_URL)
      throw new Error("REDIS_URL is required for Redis integration tests");

    const source = `
      import assert from "node:assert/strict";
      const { RedisQueryCacheRegistry } = await import("./src/lib/redis-query-cache-registry.ts");
      const { closeAllQueueResources, getSharedRedisConnection } = await import("./src/jobs/queues.ts");
      const { queryCache, RedisCacheStore } = await import("./src/lib/cache.ts");
      await import("./packages/server/src/router.ts");
      assert.ok(queryCache instanceof RedisCacheStore);
      await new RedisQueryCacheRegistry().listKeys();
      const registryClient = await getSharedRedisConnection().client;
      assert.equal(registryClient.status, "ready");
      await closeAllQueueResources();
      console.log("cleanup-complete", registryClient.status);
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "production", DEPLOY_ENVIRONMENT: "development" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = once(child, "close");
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
      });
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      const [code, signal] = await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Cleanup child did not exit naturally: ${output}`)),
            15_000,
          );
        }),
      ]);
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(output).toContain("cleanup-complete end");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    }
  });
});
