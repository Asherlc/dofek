import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ClimbingImagesRepository } from "./climbing-images-repository.ts";

describe("climbing image authorization", () => {
  let ctx: TestContext;
  const userId = randomUUID(),
    other = randomUUID(),
    log = randomUUID(),
    undated = randomUUID(),
    object = randomUUID();
  const storage = {
    sign: vi.fn(async () => "https://private.example.test/signed"),
    readImage: vi.fn(),
  };
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Photo owner'),(${other},'Other')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('climbing-photo-api','Climbing photo API')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.climbing_log_entry(id,user_id,provider_id,external_id,climbed_on) VALUES(${log},${userId},'climbing-photo-api','ascent','2026-10-02'),(${undated},${userId},'climbing-photo-api','undated',NULL)`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image_object(id,user_id,sha256,object_key,mime_type,size_bytes,width,height) VALUES(${object},${userId},${"c".repeat(64)},${`images/${userId}/photo`},'image/png',40,1,1)`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image(user_id,climbing_log_entry_id,provider_id,source_id,candidate,object_id) VALUES(${userId},${log},'climbing-photo-api','photo','{"kind":"photo","caption":null,"position":0}'::jsonb,${object})`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity_image_discovery(user_id,climbing_log_entry_id,provider_id,coverage,expected_count) VALUES(${userId},${log},'climbing-photo-api','complete',1)`,
    );
    await ctx.db.execute(sql`INSERT INTO fitness.activity_image_work(user_id,image_id,generation,state)
      SELECT user_id,id,1,'pending' FROM fitness.activity_image WHERE climbing_log_entry_id=${log}`);
    await ctx.db.execute(sql`INSERT INTO fitness.activity_image_work(user_id,image_id,generation,state)
      SELECT user_id,id,2,'terminal_failure' FROM fitness.activity_image WHERE climbing_log_entry_id=${log}`);
  });
  afterAll(async () => {
    await ctx?.cleanup();
  });
  it("signs standalone stored photos with their ascent source and coverage", async () => {
    const result = await new ClimbingImagesRepository(ctx.db, userId).getImages(log, storage);
    expect(result.images).toEqual([
      expect.objectContaining({
        url: "https://private.example.test/signed",
        sources: [expect.objectContaining({ activityId: null, climbingLogEntryId: log })],
      }),
    ]);
    expect(result.images[0]).not.toHaveProperty("objectKey");
    expect(result.acquisition).toEqual([
      expect.objectContaining({ state: "pending", attempts: 0, errorCode: null }),
    ]);
    expect(result.coverage).toEqual([
      expect.objectContaining({
        activityId: null,
        climbingLogEntryId: log,
        coverage: "complete",
        expectedCount: 1,
      }),
    ]);
  });
  it("rejects a foreign owner before storage access", async () => {
    storage.sign.mockClear();
    await expect(
      new ClimbingImagesRepository(ctx.db, other).getImages(log, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(storage.sign).not.toHaveBeenCalled();
  });
  it("applies the existing standalone calendar-date entitlement policy", async () => {
    const repo = new ClimbingImagesRepository(ctx.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      startDate: "2026-10-01",
      endDateExclusive: "2026-10-03",
      reason: "free_recent_week",
    });
    expect((await repo.getImages(log, storage)).images).toHaveLength(1);
    await expect(repo.getImages(undated, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const old = new ClimbingImagesRepository(ctx.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      startDate: "2026-10-03",
      endDateExclusive: "2026-10-04",
      reason: "free_recent_week",
    });
    await expect(old.getImages(log, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await new ClimbingImagesRepository(ctx.db, userId).getImages(undated, storage)).images,
    ).toEqual([]);
  });
  it("uses the visible attached activity date and retains standalone photos after detachment", async () => {
    const activity = randomUUID();
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${activity},${userId},'climbing-photo-api','attached','climbing','climbing','2026-10-04T12:00:00Z')`,
    );
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET activity_id=${activity} WHERE id=${log}`,
    );
    const octoberSecond = new ClimbingImagesRepository(ctx.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      startDate: "2026-10-01",
      endDateExclusive: "2026-10-03",
      reason: "free_recent_week",
    });
    await expect(octoberSecond.getImages(log, storage)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const octoberFourth = new ClimbingImagesRepository(ctx.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      startDate: "2026-10-04",
      endDateExclusive: "2026-10-05",
      reason: "free_recent_week",
    });
    expect((await octoberFourth.getImages(log, storage)).images).toHaveLength(1);
    await ctx.db.execute(
      sql`UPDATE fitness.activity SET provider_absent_at=now() WHERE id=${activity}`,
    );
    await expect(octoberFourth.getImages(log, storage)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET activity_id=NULL WHERE id=${log}`,
    );
    expect((await octoberSecond.getImages(log, storage)).images).toHaveLength(1);
  });
  it("hides absent logs and restores retained photos on reappearance", async () => {
    const repo = new ClimbingImagesRepository(ctx.db, userId);
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=now() WHERE id=${log}`,
    );
    await expect(repo.getImages(log, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ctx.db.execute(
      sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=NULL WHERE id=${log}`,
    );
    expect((await repo.getImages(log, storage)).images).toHaveLength(1);
  });
});
