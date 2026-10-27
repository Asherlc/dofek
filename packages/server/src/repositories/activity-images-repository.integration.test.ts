import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retireActivityImages } from "../../../../src/db/activity-images.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { listActivityImages } from "./activity-images-repository.ts";

describe("activity image source visibility", () => {
  let ctx: TestContext;
  const userId = randomUUID(),
    other = randomUUID(),
    first = randomUUID(),
    second = randomUUID(),
    object = randomUUID();
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Media API'),(${other},'Other API owner')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('media-api-a','Media API A'),('media-api-b','Media API B')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${first},${userId},'media-api-a','first','cycling','Ride',now()),(${second},${userId},'media-api-b','second','cycling','Ride',now())`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image_object(id,user_id,sha256,object_key,mime_type,size_bytes,width,height) VALUES(${object},${userId},${"a".repeat(64)},${`images/${userId}/${"a".repeat(64)}`},'image/png',40,1,1)`,
    );
    for (const [id, providerId] of [
      [first, "media-api-a"],
      [second, "media-api-b"],
    ])
      await ctx.db.execute(
        sql`INSERT INTO fitness.activity_image(user_id,activity_id,provider_id,source_id,candidate,object_id) VALUES(${userId},${id},${providerId},'photo',${JSON.stringify({ kind: "photo", caption: "Original caption", position: 0 })}::jsonb,${object})`,
      );
  }, 120000);
  afterAll(async () => {
    await ctx?.cleanup();
  });
  it("returns one stored file with all contributing sources and refuses another account", async () => {
    const owned = await listActivityImages(ctx.db, { userId, memberActivityIds: [first, second] });
    expect(owned.images).toHaveLength(1);
    expect(owned.images[0]?.sources).toHaveLength(2);
    expect(owned.images[0]?.sources[0]?.caption).toBe("Original caption");
    expect(
      (await listActivityImages(ctx.db, { userId: other, memberActivityIds: [first, second] }))
        .images,
    ).toHaveLength(0);
  });
  it("filters provider absence and explicit deletion independently without deleting another source", async () => {
    await ctx.db.execute(
      sql`UPDATE fitness.activity SET provider_absent_at=now() WHERE id=${first}`,
    );
    let result = await listActivityImages(ctx.db, { userId, memberActivityIds: [first, second] });
    expect(result.images[0]?.sources.map((source) => source.activityId)).toEqual([second]);
    await retireActivityImages(ctx.db, { userId, activityIds: [second] });
    result = await listActivityImages(ctx.db, { userId, memberActivityIds: [first, second] });
    expect(result.images).toHaveLength(0);
    const objects = await ctx.db.execute(
      sql`SELECT id FROM fitness.activity_image_object WHERE id=${object}`,
    );
    expect(objects).toHaveLength(1);
  });
});

describe("climbing-owned image attachment", () => {
  let ctx: TestContext;
  const userId = randomUUID(),
    other = randomUUID(),
    first = randomUUID(),
    second = randomUUID(),
    log = randomUUID(),
    object = randomUUID();
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Climbing photos'),(${other},'Other')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('climb-media','Climbing media')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${first},${userId},'climb-media','one','climbing','climbing',now()),(${second},${userId},'climb-media','two','climbing','climbing',now())`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.climbing_log_entry(id,user_id,provider_id,external_id,activity_id,climbed_on) VALUES(${log},${userId},'climb-media','ascent',${first},CURRENT_DATE)`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image_object(id,user_id,sha256,object_key,mime_type,size_bytes,width,height) VALUES(${object},${userId},${"b".repeat(64)},${`images/${userId}/climb`},'image/png',40,1,1)`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image(user_id,climbing_log_entry_id,provider_id,source_id,candidate,object_id) VALUES(${userId},${log},'climb-media','ascent-photo','{"kind":"photo","caption":"Ascent","position":0}'::jsonb,${object})`,
    );
  });
  afterAll(async () => {
    await ctx?.cleanup();
  });
  it("follows current attachments and absence without moving the source association", async () => {
    const read = (ids: string[], owner = userId) =>
      listActivityImages(ctx.db, { userId: owner, memberActivityIds: ids });
    expect((await read([first], other)).images).toEqual([]);
    expect((await read([first])).images[0]?.sources).toEqual([
      expect.objectContaining({ activityId: null, climbingLogEntryId: log, caption: "Ascent" }),
    ]);
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image(user_id,activity_id,provider_id,source_id,candidate,object_id) VALUES(${userId},${first},'climb-media','workout-photo','{"kind":"photo","caption":null,"position":0}'::jsonb,${object})`,
    );
    const combined = await read([first, second]);
    expect(combined.images).toHaveLength(1);
    expect(combined.images[0]?.sources).toHaveLength(2);
    await ctx.db.execute(sql`DELETE FROM fitness.activity_image WHERE activity_id=${first}`);
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET activity_id=${second} WHERE id=${log}`,
    );
    expect((await read([first])).images).toEqual([]);
    expect((await read([first, second])).images).toHaveLength(1);
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=now() WHERE id=${log}`,
    );
    expect((await read([second])).images).toEqual([]);
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=NULL, activity_id=NULL WHERE id=${log}`,
    );
    expect((await read([second])).images).toEqual([]);
  });
});
