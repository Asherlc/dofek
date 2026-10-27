import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImageDiscovery } from "../activity-images/types.ts";
import {
  completeActivityImageWork,
  listPendingActivityImageWork,
  loadActivityImageWork,
  recordActivityImageDiscovery,
  recordClimbingImageDiscovery,
  retireActivityImages,
} from "./activity-images.ts";
import { activityImage, activityImageWork } from "./schema/activity-images.ts";
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
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${a},${user},'image-test','a','cycling','Ride',now()),(${b},${other},'image-test','b','cycling','Ride',now())`,
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
  it("keeps URL rotation, retry budgets and stored copies within one generation", async () => {
    const record = (value: ImageDiscovery) =>
      recordActivityImageDiscovery(ctx.db, {
        userId: other,
        activityId: b,
        providerId: "image-test",
        discovery: value,
      });
    await record(discovery);
    const [first] = await ctx.db
      .select()
      .from(activityImage)
      .where(eq(activityImage.activityId, b));
    if (!first) throw Error("Missing association");
    const rotated = {
      ...discovery,
      images: discovery.images.map((candidate) => ({
        ...candidate,
        variants: [{ url: "https://cdn.example/image.png?sig=new", width: 100, height: 100 }],
      })),
    };
    await record(rotated);
    let work = await ctx.db
      .select()
      .from(activityImageWork)
      .where(eq(activityImageWork.imageId, first.id));
    expect(work).toHaveLength(1);
    expect(
      (await loadActivityImageWork(ctx.db, work[0]?.id ?? "", other))?.candidate.variants[0]?.url,
    ).toContain("sig=new");
    await ctx.db.execute(
      sql`UPDATE fitness.activity_image_work SET state='terminal_failure',attempts=5 WHERE image_id=${first.id}::uuid`,
    );
    await record(discovery);
    work = await ctx.db
      .select()
      .from(activityImageWork)
      .where(eq(activityImageWork.imageId, first.id));
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ state: "terminal_failure", attempts: 5 });
    await record({
      ...rotated,
      images: rotated.images.map((candidate) => ({ ...candidate, revision: "v2" })),
    });
    work = await ctx.db
      .select()
      .from(activityImageWork)
      .where(eq(activityImageWork.imageId, first.id));
    expect(work).toHaveLength(2);
    const current = work.find((item) => item.generation === 2);
    const loaded = await loadActivityImageWork(ctx.db, current?.id ?? "", other);
    if (!loaded) throw Error("Missing new revision work");
    await completeActivityImageWork(ctx.db, loaded, {
      sha256: "b".repeat(64),
      objectKey: `images/${other}/revision`,
      mimeType: "image/png",
      sizeBytes: 10,
      width: 100,
      height: 100,
    });
    const [stored] = await ctx.db
      .select()
      .from(activityImage)
      .where(eq(activityImage.id, first.id));
    await record({
      ...discovery,
      images: discovery.images.map((candidate) => ({ ...candidate, revision: "v2" })),
    });
    const [unchanged] = await ctx.db
      .select()
      .from(activityImage)
      .where(eq(activityImage.id, first.id));
    expect(unchanged?.objectId).toBe(stored?.objectId);
    expect(unchanged?.generation).toBe(2);
    expect(
      await ctx.db.select().from(activityImageWork).where(eq(activityImageWork.imageId, first.id)),
    ).toHaveLength(2);
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
      discovery: {
        ...discovery,
        images: discovery.images.map((candidate) => ({ ...candidate, revision: "revised" })),
      },
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

describe("climbing image persistence", () => {
  let ctx: TestContext;
  const userId = randomUUID();
  const otherId = randomUUID();
  const providerId = "climbing-image-test";
  const discovery: ImageDiscovery = {
    coverage: "complete",
    expectedCount: 1,
    reason: null,
    images: [
      {
        sourceId: "ascent:photo",
        kind: "photo",
        caption: "Ascent",
        position: 0,
        variants: [{ url: "https://cdn.example/ascent.jpg", width: null, height: null }],
        revision: "photo-a",
        raw: {},
      },
    ],
  };
  const metadata = {
    sha256: "c".repeat(64),
    objectKey: `images/${userId}/ascent`,
    mimeType: "image/jpeg",
    sizeBytes: 100,
    width: 100,
    height: 100,
  };
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Climber'),(${otherId},'Other climber')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES(${providerId},'Climbing images'),('other-image-source','Other source') ON CONFLICT DO NOTHING`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_connection(user_id,provider_id) VALUES(${userId},${providerId})`,
    );
  });
  afterAll(async () => {
    await ctx?.cleanup();
  });
  async function createLog() {
    const id = randomUUID();
    await ctx.db.execute(
      sql`INSERT INTO fitness.climbing_log_entry(id,user_id,provider_id,external_id) VALUES(${id},${userId},${providerId},${id})`,
    );
    return id;
  }
  async function record(id: string, value = discovery) {
    await recordClimbingImageDiscovery(ctx.db, {
      userId,
      climbingLogEntryId: id,
      providerId,
      discovery: value,
    });
    const rows = await ctx.db
      .select()
      .from(activityImage)
      .where(eq(activityImage.climbingLogEntryId, id));
    return rows[0];
  }
  async function load(id: string) {
    const rows = await ctx.db
      .select()
      .from(activityImageWork)
      .where(eq(activityImageWork.imageId, id));
    const latest = rows.sort((a, b) => b.generation - a.generation)[0];
    if (!latest) throw Error("Missing acquisition work");
    return loadActivityImageWork(ctx.db, latest.id, userId);
  }

  it("acquires a standalone log photo and keeps it after its attached activity is deleted", async () => {
    const id = await createLog();
    const image = await record(id);
    if (!image) throw Error("Missing ascent photo");
    const work = await load(image.id);
    expect(work).toMatchObject({
      activityId: null,
      climbingLogEntryId: id,
      activityExternalId: id,
    });
    if (!work) throw Error("Missing standalone work");
    expect(await listPendingActivityImageWork(ctx.db)).toContainEqual({ id: work.id, userId });
    expect(await completeActivityImageWork(ctx.db, work, metadata)).toBe(true);
    const outing = randomUUID();
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${outing},${userId},${providerId},${outing},'climbing','Climb',now())`,
    );
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET activity_id=${outing} WHERE id=${id}`,
    );
    await ctx.db.execute(sql`DELETE FROM fitness.activity WHERE id=${outing}`);
    const [retained] = await ctx.db
      .select()
      .from(activityImage)
      .where(eq(activityImage.id, image.id));
    expect(retained?.objectId).not.toBeNull();
    await ctx.db.execute(sql`DELETE FROM fitness.climbing_log_entry WHERE id=${id}`);
    expect(
      await ctx.db.select().from(activityImageWork).where(eq(activityImageWork.imageId, image.id)),
    ).toHaveLength(0);
  });

  it("enforces one owner and the climbing owner/provider identity in both association tables", async () => {
    const id = await createLog();
    for (const table of ["activity_image", "activity_image_discovery"]) {
      const values = table === "activity_image" ? sql`source_id,candidate` : sql`coverage`;
      const data = table === "activity_image" ? sql`'invalid','{}'::jsonb` : sql`'complete'`;
      await expect(
        ctx.db.execute(
          sql`INSERT INTO fitness.${sql.identifier(table)}(user_id,provider_id,${values}) VALUES(${userId},${providerId},${data})`,
        ),
      ).rejects.toThrow();
      await expect(
        ctx.db.execute(
          sql`INSERT INTO fitness.${sql.identifier(table)}(user_id,provider_id,climbing_log_entry_id,${values}) VALUES(${otherId},${providerId},${id},${data})`,
        ),
      ).rejects.toThrow();
      await expect(
        ctx.db.execute(
          sql`INSERT INTO fitness.${sql.identifier(table)}(user_id,provider_id,climbing_log_entry_id,${values}) VALUES(${userId},'other-image-source',${id},${data})`,
        ),
      ).rejects.toThrow();
      const outing = randomUUID();
      await ctx.db.execute(
        sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${outing},${userId},${providerId},${outing},'climbing','Climb',now())`,
      );
      await expect(
        ctx.db.execute(
          sql`INSERT INTO fitness.${sql.identifier(table)}(user_id,provider_id,activity_id,climbing_log_entry_id,${values}) VALUES(${userId},${providerId},${outing},${id},${data})`,
        ),
      ).rejects.toThrow();
    }
    await recordClimbingImageDiscovery(ctx.db, {
      userId: otherId,
      climbingLogEntryId: id,
      providerId,
      discovery,
    });
    await recordClimbingImageDiscovery(ctx.db, {
      userId,
      climbingLogEntryId: id,
      providerId: "other-image-source",
      discovery,
    });
    expect(
      await ctx.db.select().from(activityImage).where(eq(activityImage.climbingLogEntryId, id)),
    ).toHaveLength(0);
  });

  it("pauses absent or disconnected logs and restores pending work on reappearance/reconnection", async () => {
    const id = await createLog();
    const image = await record(id);
    if (!image) throw Error("Missing photo");
    const work = await load(image.id);
    if (!work) throw Error("Missing work");
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=now() WHERE id=${id}`,
    );
    expect(await load(image.id)).toBeNull();
    expect(await listPendingActivityImageWork(ctx.db)).not.toContainEqual({ id: work.id, userId });
    expect(await completeActivityImageWork(ctx.db, work, metadata)).toBe(false);
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=NULL WHERE id=${id}`,
    );
    expect(await load(image.id)).toMatchObject({ id: work.id });
    await ctx.db.execute(
      sql`DELETE FROM fitness.provider_connection WHERE user_id=${userId} AND provider_id=${providerId}`,
    );
    expect(await load(image.id)).toBeNull();
    expect(await completeActivityImageWork(ctx.db, work, metadata)).toBe(false);
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider_connection(user_id,provider_id) VALUES(${userId},${providerId})`,
    );
    expect(await load(image.id)).toMatchObject({ id: work.id });
  });

  it("keeps stored copies on failed discovery, retires confirmed removed photos, and reacquires returning photos", async () => {
    const id = await createLog();
    const image = await record(id);
    if (!image) throw Error("Missing photo");
    const work = await load(image.id);
    if (!work) throw Error("Missing work");
    await completeActivityImageWork(ctx.db, work, metadata);
    const failed = await record(id, {
      coverage: "failed",
      expectedCount: null,
      reason: "request_failed",
      images: [],
    });
    expect(failed).toMatchObject({ objectId: expect.any(String), retiredAt: null, generation: 1 });
    const removed = await record(id, {
      coverage: "complete",
      expectedCount: 0,
      reason: null,
      images: [],
    });
    expect(removed?.retiredAt).not.toBeNull();
    expect(removed?.objectId).toBeNull();
    const returned = await record(id);
    expect(returned).toMatchObject({ id: image.id, retiredAt: null });
    expect(await load(image.id)).toMatchObject({ candidate: { sourceId: "ascent:photo" } });
  });

  it("rotates URLs without new work and supersedes replaced photographs", async () => {
    const id = await createLog();
    const first = await record(id);
    if (!first) throw Error("Missing image");
    const work = await load(first.id);
    if (!work) throw Error("Missing work");
    const rotated = await record(id, {
      ...discovery,
      images: discovery.images.map((c) => ({
        ...c,
        variants: [
          { url: "https://cdn.example/ascent.jpg?token=rotated", width: null, height: null },
        ],
      })),
    });
    expect(rotated?.generation).toBe(first.generation);
    expect(
      await ctx.db.select().from(activityImageWork).where(eq(activityImageWork.imageId, first.id)),
    ).toHaveLength(1);
    const replaced = await record(id, {
      ...discovery,
      images: discovery.images.map((c) => ({ ...c, revision: "photo-b" })),
    });
    expect(replaced?.generation).toBe(first.generation + 1);
    expect(await completeActivityImageWork(ctx.db, work, metadata)).toBe(false);
    const current = await load(first.id);
    expect(current?.candidate.revision).toBe("photo-b");
    if (!current) throw Error("Missing replacement work");
    expect(await completeActivityImageWork(ctx.db, current, metadata)).toBe(true);
  });
});
