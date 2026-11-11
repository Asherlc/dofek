import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../src/analytics/analytics-query-owner.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../src/db/test-helpers.ts";

describe("actual analytics entrypoint admission", () => {
  let context: TestContext;
  const client = createClickHouseClientFromEnv();
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterAll(async () => {
    await client.close?.();
    await context?.cleanup();
  });
  it.each(["run-analytics-build.ts", "run-local-analytics-build.ts"])(
    "blocks %s before any child publication",
    async (script) => {
      const admitted = createTestBarrier(),
        release = createTestBarrier();
      const held = withAnalyticsQueryOwner(
        context.db,
        client,
        { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: "erasure-entrypoint-fixture" },
        async () => {
          admitted.resolve();
          await release.promise;
        },
      );
      await admitted.promise;
      const child = spawn(process.execPath, ["--import", "tsx", `scripts/${script}`], {
        env: { ...process.env, DATABASE_URL: context.connectionString },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      let output = "";
      for (const stream of [child.stdout, child.stderr])
        stream?.on("data", (chunk) => {
          output = (output + String(chunk)).slice(-8192);
        });
      try {
        await vi.waitFor(
          async () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(`Writer exited before admission: ${output}`);
            expect(await hasDatabaseLockWaiter(context.db)).toBe(true);
          },
          { timeout: 10000 },
        );
        expect(child.exitCode).toBeNull();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
        release.resolve();
        await held;
      }
    },
    30000,
  );
});
