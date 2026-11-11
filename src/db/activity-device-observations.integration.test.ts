import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replaceActivityDeviceObservations } from "./activity-device-observations.ts";
import { activity, activityDeviceObservation } from "./schema/activity.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("activity device observations", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "fit-device-test", "FIT devices");
  }, 60_000);
  afterAll(async () => {
    if (context) await context.cleanup();
  });

  async function fixture() {
    const [row] = await context.db
      .insert(activity)
      .values({
        providerId: "fit-device-test",
        externalId: randomUUID(),
        canonicalType: "cycling",
        providerType: "cycling",
        startedAt: new Date(),
      })
      .returning({ activityId: activity.id, userId: activity.userId });
    if (!row) throw new Error("Missing activity fixture");
    return row;
  }

  it("retains repeated raw messages, replaces idempotently, and cascades on deletion", async () => {
    const scope = await fixture();
    async function* batches() {
      yield [{ messageType: "file_id" as const, raw: { manufacturer: 1, serial_number: 123 } }];
      yield [
        {
          messageType: "device_info" as const,
          raw: { device_index: 1, product_name: "Power meter" },
        },
        { messageType: "device_info" as const, raw: { device_index: 1, battery_voltage: 2.9 } },
      ];
    }
    await replaceActivityDeviceObservations(context.db, scope, batches());
    await replaceActivityDeviceObservations(context.db, scope, batches());
    const rows = await context.db
      .select()
      .from(activityDeviceObservation)
      .where(eq(activityDeviceObservation.activityId, scope.activityId))
      .orderBy(activityDeviceObservation.sequence);
    expect(rows).toEqual([
      {
        activityId: scope.activityId,
        sequence: 0,
        messageType: "file_id",
        raw: { manufacturer: 1, serial_number: 123 },
      },
      {
        activityId: scope.activityId,
        sequence: 1,
        messageType: "device_info",
        raw: { device_index: 1, product_name: "Power meter" },
      },
      {
        activityId: scope.activityId,
        sequence: 2,
        messageType: "device_info",
        raw: { device_index: 1, battery_voltage: 2.9 },
      },
    ]);
    await context.db.delete(activity).where(eq(activity.id, scope.activityId));
    expect(
      await context.db
        .select()
        .from(activityDeviceObservation)
        .where(eq(activityDeviceObservation.activityId, scope.activityId)),
    ).toEqual([]);
  });

  it("rejects foreign ownership and rolls back an interrupted replacement", async () => {
    const scope = await fixture();
    async function* original() {
      yield [{ messageType: "device_info" as const, raw: { serial_number: 42 } }];
    }
    await replaceActivityDeviceObservations(context.db, scope, original());
    await expect(
      replaceActivityDeviceObservations(context.db, { ...scope, userId: randomUUID() }, original()),
    ).rejects.toThrow("owned activity");
    async function* interrupted() {
      yield [{ messageType: "device_info" as const, raw: { serial_number: 43 } }];
      throw new Error("spool read failed");
    }
    await expect(
      replaceActivityDeviceObservations(context.db, scope, interrupted()),
    ).rejects.toThrow("spool read failed");
    expect(
      await context.db
        .select()
        .from(activityDeviceObservation)
        .where(eq(activityDeviceObservation.activityId, scope.activityId)),
    ).toEqual([
      {
        activityId: scope.activityId,
        sequence: 0,
        messageType: "device_info",
        raw: { serial_number: 42 },
      },
    ]);
  });

  it("enforces sequence uniqueness and nonnegative values in Postgres", async () => {
    const scope = await fixture();
    const row = {
      activityId: scope.activityId,
      sequence: 0,
      messageType: "file_id" as const,
      raw: {},
    };
    await context.db.insert(activityDeviceObservation).values(row);
    await expect(context.db.insert(activityDeviceObservation).values(row)).rejects.toThrow();
    await expect(
      context.db.insert(activityDeviceObservation).values({ ...row, sequence: -1 }),
    ).rejects.toThrow();
  });

  it("replaces with an empty observation set and rejects an oversized batch atomically", async () => {
    const scope = await fixture();
    async function* original() {
      yield [{ messageType: "file_id" as const, raw: { manufacturer: 1 } }];
    }
    await replaceActivityDeviceObservations(context.db, scope, original());
    async function* oversized() {
      yield Array.from({ length: 251 }, () => ({ messageType: "device_info" as const, raw: {} }));
    }
    await expect(replaceActivityDeviceObservations(context.db, scope, oversized())).rejects.toThrow(
      "250 messages",
    );
    expect(
      await context.db
        .select()
        .from(activityDeviceObservation)
        .where(eq(activityDeviceObservation.activityId, scope.activityId)),
    ).toHaveLength(1);
    async function* empty() {
      yield [];
    }
    await replaceActivityDeviceObservations(context.db, scope, empty());
    expect(
      await context.db
        .select()
        .from(activityDeviceObservation)
        .where(eq(activityDeviceObservation.activityId, scope.activityId)),
    ).toEqual([]);
  });
});
