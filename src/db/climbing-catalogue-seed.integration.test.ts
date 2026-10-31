import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadCatalogueSeed } from "./climbing-catalogue-seed.ts";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import { activity } from "./schema/activity.ts";
import { area, climb, climbingLogEntry } from "./schema/climbing.ts";
import { TEST_USER_ID as userId } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("loadCatalogueSeed PostgreSQL visibility and source metadata", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity);
  });
  afterAll(async () => {
    await context.cleanup();
  });
  async function write(source: Partial<SourceClimbingLogEntry> = {}) {
    const result = await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "openbeta",
      entries: [
        {
          externalId: "log-id",
          title: "Log title",
          climb: {
            externalId: "climb-id",
            name: "Source name",
            kind: "boulder",
            setting: "outdoor",
          },
          attempts: [{ scope: "climb" }],
          ...source,
        },
      ],
    });
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected source log");
    return id;
  }
  async function attach() {
    const [parent] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "session",
        canonicalType: "climbing",
        providerType: "bouldering",
        startedAt: new Date("2026-10-01T12:00:00Z"),
      })
      .returning();
    if (!parent) throw new Error("Expected activity");
    return { parent, id: await write({ activityId: parent.id }) };
  }
  it("preserves source climb identity and every native location scope", async () => {
    const id = await write({
      climb: {
        externalId: "source-climb",
        name: "Native climb",
        kind: "boulder",
        setting: "outdoor",
        coordinates: { latitude: 0, longitude: -122 },
        areas: [
          { externalId: "country", name: "Country", coordinates: { latitude: 30, longitude: 0 } },
          { externalId: "wall", name: "Wall" },
        ],
      },
      raw: { url: "https://unverified.example/" },
    });
    expect(await loadCatalogueSeed(context.db, userId, id)).toEqual({
      userId,
      logEntryId: id,
      providerId: "openbeta",
      externalId: "source-climb",
      sourceUrl: null,
      name: "Native climb",
      kind: "boulder",
      setting: "outdoor",
      locations: [
        {
          externalId: "source-climb",
          name: "Native climb",
          scope: "climb",
          coordinates: { latitude: 0, longitude: -122 },
        },
        {
          externalId: "country",
          name: "Country",
          scope: "area",
          coordinates: { latitude: 30, longitude: 0 },
        },
        { externalId: "wall", name: "Wall", scope: "area", coordinates: null },
      ],
    });
  });
  it("rejects another user's log", async () => {
    const id = await write();
    expect(await loadCatalogueSeed(context.db, userId, id)).not.toBeNull();
    expect(
      await loadCatalogueSeed(context.db, "00000000-0000-4000-8000-000000000099", id),
    ).toBeNull();
  });
  it("rejects absent logs", async () => {
    const id = await write();
    expect(await loadCatalogueSeed(context.db, userId, id)).not.toBeNull();
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, id));
    expect(await loadCatalogueSeed(context.db, userId, id)).toBeNull();
  });
  it.each(["deletedAt", "providerAbsentAt"] as const)(
    "rejects attached activity with %s",
    async (field) => {
      const { parent, id } = await attach();
      expect(await loadCatalogueSeed(context.db, userId, id)).not.toBeNull();
      await context.db
        .update(activity)
        .set({ [field]: new Date() })
        .where(eq(activity.id, parent.id));
      expect(await loadCatalogueSeed(context.db, userId, id)).toBeNull();
    },
  );
  it("reflects changed source names in refreshed seeds", async () => {
    const id = await write();
    expect((await loadCatalogueSeed(context.db, userId, id))?.name).toBe("Source name");
    await context.db
      .update(climb)
      .set({ name: "Renamed source" })
      .where(eq(climb.externalId, "climb-id"));
    expect((await loadCatalogueSeed(context.db, userId, id))?.name).toBe("Renamed source");
  });
  it("uses recorded titles and preserves unnamed source identities", async () => {
    const id = await write({
      climb: {
        externalId: "climb-id",
        name: null,
        kind: "summit",
        coordinates: { latitude: 37, longitude: -122 },
      },
    });
    expect(await loadCatalogueSeed(context.db, userId, id)).toMatchObject({
      name: "Log title",
      kind: null,
    });
    await context.db
      .update(climbingLogEntry)
      .set({ title: null })
      .where(eq(climbingLogEntry.id, id));
    expect(await loadCatalogueSeed(context.db, userId, id)).toMatchObject({
      name: null,
      externalId: "climb-id",
      locations: [
        {
          externalId: "climb-id",
          name: null,
          scope: "climb",
          coordinates: { latitude: 37, longitude: -122 },
        },
      ],
    });
  });
  it("does not substitute the log identity when no source climb exists", async () => {
    const id = await write({ climb: undefined });
    expect(await loadCatalogueSeed(context.db, userId, id)).toMatchObject({
      externalId: null,
      name: "Log title",
      kind: null,
      locations: [],
    });
  });
});
