import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { listActivityHardware } from "./activity-hardware-repository.ts";
import { ActivityRepository } from "./activity-repository.ts";

describe("owned activity hardware", () => {
  let ctx: TestContext;
  const userId = randomUUID(),
    other = randomUUID(),
    visible = randomUUID(),
    absent = randomUUID(),
    deleted = randomUUID(),
    foreign = randomUUID();
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile(id,name) VALUES(${userId},'Hardware'),(${other},'Other hardware')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('hardware-test','Hardware test')`,
    );
    for (const id of [visible, absent, deleted, foreign]) {
      await ctx.db.execute(
        sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at) VALUES(${id},${id === foreign ? other : userId},'hardware-test',${id},'cycling','Ride',now())`,
      );
      await ctx.db.execute(
        sql`INSERT INTO fitness.activity_device_observation(activity_id,sequence,message_type,raw) VALUES(${id},0,'file_id','{"product_name":"Edge 530","manufacturer":1}'::jsonb),(${id},1,'device_info','{"device_index":1,"product_name":"HRM","serial_number":123}'::jsonb),(${id},2,'device_info','{"device_index":1,"battery_voltage":2.7}'::jsonb)`,
      );
    }
    await ctx.db.execute(
      sql`UPDATE fitness.activity SET provider_absent_at=now() WHERE id=${absent}`,
    );
    await ctx.db.execute(sql`UPDATE fitness.activity SET deleted_at=now() WHERE id=${deleted}`);
  });
  afterAll(async () => {
    await ctx?.cleanup();
  });
  it("filters foreign, deleted, and provider-absent members and merges partial observations only on read", async () => {
    const result = await listActivityHardware(ctx.db, {
      userId,
      memberActivityIds: [visible, absent, deleted, foreign],
    });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.activityId === visible)).toBe(true);
    expect(result.items[1]?.details).toContainEqual({ label: "Serial number", value: "123" });
    expect(result.items[1]?.details).toContainEqual({ label: "Battery voltage", value: "2.7 V" });
    expect(
      await listActivityHardware(ctx.db, { userId: other, memberActivityIds: [visible] }),
    ).toEqual({ items: [], power: [] });
    const stored = await ctx.db.execute(
      sql`SELECT sequence FROM fitness.activity_device_observation WHERE activity_id=${visible}`,
    );
    expect(stored).toHaveLength(3);
  });
  it("resolves owned activity IDs and rejects inaccessible windows before hardware reads", async () => {
    const repository = new ActivityRepository(ctx.db, userId);
    expect((await repository.getHardware(visible)).items).toHaveLength(2);
    for (const id of [foreign, absent, deleted, randomUUID()]) {
      await expect(repository.getHardware(id)).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Activity not found",
      });
    }
    const limited = new ActivityRepository(ctx.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2020-01-01",
      endDateExclusive: "2020-01-08",
    });
    await expect(limited.getHardware(visible)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Activity not found",
    });
  });
  it("keeps stored creator provenance, colliding sensor identities, and separate API recorder facts", async () => {
    const id = randomUUID();
    await ctx.db.execute(
      sql`INSERT INTO fitness.provider(id,name) VALUES('garmin','Garmin') ON CONFLICT DO NOTHING`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity(id,user_id,provider_id,external_id,canonical_type,provider_type,started_at,raw) VALUES(${id},${userId},'garmin',${id},'cycling','Ride',now(),'{"deviceName":"Edge 530"}'::jsonb)`,
    );
    await ctx.db.execute(sql`INSERT INTO fitness.activity_device_observation(activity_id,sequence,message_type,raw) VALUES
      (${id},0,'file_id','{"product_name":"Export platform"}'::jsonb),
      (${id},1,'device_info','{"device_index":1,"manufacturer":1,"product_name":"Sensor A","serial_number":123}'::jsonb),
      (${id},2,'device_info','{"device_index":2,"manufacturer":32,"product_name":"Sensor B","serial_number":123}'::jsonb),
      (${id},3,'device_info','{"device_index":2,"battery_voltage":2.7}'::jsonb)`);
    const result = await listActivityHardware(ctx.db, { userId, memberActivityIds: [id] });
    expect(result.items.map((item) => [item.role, item.label])).toEqual([
      ["creator", "Export platform"],
      ["sensor", "Sensor A"],
      ["sensor", "Sensor B"],
      ["recorder", "Edge 530"],
    ]);
    expect(result.items[2]?.details).toContainEqual({ label: "Battery voltage", value: "2.7 V" });
    const observations = await ctx.db.execute(
      sql`SELECT sequence FROM fitness.activity_device_observation WHERE activity_id=${id}`,
    );
    expect(observations).toHaveLength(4);
  });
});
