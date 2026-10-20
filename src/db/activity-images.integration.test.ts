import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImageDiscovery } from "../activity-images/types.ts";
import {
  completeActivityImageWork,
  listPendingActivityImageWork,
  loadActivityImageWork,
  recordActivityImageDiscovery,
  retireActivityImages,
} from "./activity-images.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("activity image persistence", () => {
  let ctx: TestContext;
  const user = randomUUID(),
    other = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  const discovery: ImageDiscovery = {
    coverage: "complete",
    expectedCount: 1,
    reason: null,
    images: [
      {
        sourceId: "photo1",
        kind: "photo",
        caption: "Original caption",
        position: 0,
        variants: [{ url: "https://cdn.example/image.png?sig=old", width: 100, height: 100 }],
        revision: null,
        raw: {},
      },
    ],
  };
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${user},'Image user'),(${other},'Other image user')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('image-test','Image test') ON CONFLICT DO NOTHING`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_connection(user_id,provider_id) VALUES(${user},'image-test'),(${other},'image-test')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${a},${user},'image-test','a','cycling','Ride',now()),(${b},${other},'image-test','b','cycling',now())`,
    );
  });
  afterAll(async () => {
    await ctx?.cleanup();
  });
  it("records discovery and work atomically and refuses another owner", async () => {
    await recordActivityImageDiscovery(ctx.db, {
      userId: other,
      activityId: a,
      providerId: "image-test",
      discovery,
    });
    expect(await listPendingActivityImageWork(ctx.db)).toHaveLength(0);
    await recordActivityImageDiscovery(ctx.db, {
      userId: user,
      activityId: a,
      providerId: "image-test",
      discovery,
    });
    const work = await listPendingActivityImageWork(ctx.db);
    expect(work).toHaveLength(1);
    expect(await loadActivityImageWork(ctx.db, work[0]?.id ?? "", other)).toBeNull();
  });
  it("rejects cross-user object and activity references", async () => {
    await expect(
      ctx.db.execute(
        sql`INSERT INTO fitness.activity_image(user_id,activity_id,provider_id,source_id,candidate) VALUES(${user},${b},'image-test','illegal','{}')`,
      ),
    ).rejects.toThrow();
  });
  it("does not attach superseded or retired work", async () => {
    const pending = await listPendingActivityImageWork(ctx.db);
    const row = pending[0];
    if (!row) throw Error("Missing pending image");
    const work = await loadActivityImageWork(ctx.db, row.id, user);
    if (!work) throw Error("Missing work");
    await recordActivityImageDiscovery(ctx.db, {
      userId: user,
      activityId: a,
      providerId: "image-test",
      discovery,
    });
    expect(
      await completeActivityImageWork(ctx.db, work, {
        sha256: "a".repeat(64),
        objectKey: `images/${user}/hash`,
        mimeType: "image/png",
        sizeBytes: 10,
        width: 100,
        height: 100,
      }),
    ).toBe(false);
    await retireActivityImages(ctx.db, { userId: user, activityIds: [a] });
    expect(await listPendingActivityImageWork(ctx.db)).toHaveLength(0);
  });
});
