import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { CreateBucketCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSeaweedFsS3Container } from "../account-erasure/test-helpers.ts";
import { createActivityImageJobDependencies } from "../activity-images/acquire.ts";
import { inspectImageBytes } from "../activity-images/download.ts";
import { activityImageObjectKey, eraseActivityImageObjects } from "../activity-images/storage.ts";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import {
  listPendingActivityImageWork,
  recordActivityImageDiscovery,
} from "../db/activity-images.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../db/test-helpers.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import {
  createAccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";
import { processActivityImageJob } from "./process-activity-image-job.ts";

describe("account erasure racing with image acquisition", () => {
  let ctx: TestContext, container: StartedTestContainer, client: S3Client;
  const server = createIntegrationMswFixture();
  const userId = randomUUID(),
    activityId = randomUUID(),
    bucket = "media-erasure-race";
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    container = await createSeaweedFsS3Container({
      accessKeyId: "media",
      secretAccessKey: "media-secret",
    }).start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    client = new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: "media", secretAccessKey: "media-secret" },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    vi.stubEnv("R2_ENDPOINT", endpoint);
    vi.stubEnv("R2_ACCESS_KEY_ID", "media");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "media-secret");
    vi.stubEnv("ACTIVITY_MEDIA_R2_BUCKET", bucket);
    server.activate({ onUnhandledRequest: "bypass" });
    syncBuiltinESMExports();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Media erasure race')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('media-race','Media race')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_connection(user_id,provider_id) VALUES(${userId},'media-race')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${activityId},${userId},'media-race','ride','cycling','Ride',now())`,
    );
  }, 120000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    client?.destroy();
    server.deactivate();
    syncBuiltinESMExports();
    await container?.stop();
    await ctx?.cleanup();
  });
  it("waits for an admitted upload, purges it, and refuses a late recreation", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
      "base64",
    );
    const metadata = await inspectImageBytes(bytes, "image/png");
    const started = createTestBarrier(),
      release = createTestBarrier();
    const served = vi.fn();
    server.use(
      http.get("https://8.8.8.8/photo", async () => {
        served();
        started.resolve();
        await release.promise;
        return new HttpResponse(new Uint8Array(bytes), {
          headers: { "content-type": "image/png" },
        });
      }),
    );
    await recordActivityImageDiscovery(ctx.db, {
      userId,
      activityId,
      providerId: "media-race",
      discovery: {
        coverage: "complete",
        expectedCount: 1,
        reason: null,
        images: [
          {
            sourceId: "photo",
            kind: "photo",
            caption: null,
            position: 0,
            variants: [{ url: "https://8.8.8.8/photo", width: 1, height: 1 }],
            revision: null,
            raw: {},
          },
        ],
      },
    });
    const [work] = await listPendingActivityImageWork(ctx.db);
    if (!work) throw Error("No acquisition work");
    const pool = createAccountErasureWorkLockPool(ctx.connectionString);
    ctx.addCleanup(() => pool.close());
    const acquire = () =>
      runQueuedUserWorkUnlessAccountErasing(
        pool,
        ctx.db,
        userId,
        "activity image race",
        () =>
          processActivityImageJob(
            { workId: work.id, userId },
            createActivityImageJobDependencies(ctx.db),
          ),
        "media-race",
      );
    const upload = acquire();
    await started.promise;
    const snapshot = vi.fn(async () => "encrypted-media-race-snapshot");
    const erasure = initiateAccountErasure(ctx.db, userId, snapshot, async () => undefined);
    try {
      const deadline = Date.now() + 5000;
      while (!(await hasDatabaseLockWaiter(ctx.db))) {
        if (Date.now() > deadline) throw Error("Erasure never waited for upload");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await upload;
    await erasure;
    await eraseActivityImageObjects(userId);
    await acquire();
    expect(served).toHaveBeenCalledOnce();
    await expect(
      client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: activityImageObjectKey(userId, metadata.sha256),
        }),
      ),
    ).rejects.toThrow();
  });
});
