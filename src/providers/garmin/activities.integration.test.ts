import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity } from "../../db/schema/activity.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider } from "../../db/tokens.ts";
import {
  type ProviderArtifactStorage,
  R2ProviderArtifactStorage,
} from "../../provider-artifact-storage.ts";
import { createCapturingMetricStreamPublisher } from "../test-helpers.ts";
import { syncGarminActivityRecord } from "./activities.ts";

const summary = {
  userId: "garmin-owner",
  summaryId: "summary-first",
  activityId: 1234567890,
  activityType: "RUNNING",
  activityName: "Morning run",
  startTimeInSeconds: 1792454400,
  startTimeOffsetInSeconds: -25200,
  durationInSeconds: 1800,
  manual: true,
};
const artifacts: ProviderArtifactStorage = {
  async ensureArtifact() {
    throw new Error("Summary must not download an artifact");
  },
  async materializeArtifact() {
    throw new Error("Summary must not materialize an artifact");
  },
  async deleteForUser() {
    throw new Error("Summary must not delete an artifact");
  },
  async deleteForProvider() {
    throw new Error("Summary must not delete an artifact");
  },
};
const dependencies = { artifacts, fetchFn: globalThis.fetch, accessToken: "test-access" };

describe("official Garmin activity persistence", () => {
  let context: TestContext;
  const server = setupServer();
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    context = await setupTestDatabase();
    await ensureProvider(context.db, "garmin", "Garmin", undefined, TEST_USER_ID);
  }, 60_000);
  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.close();
    await context?.cleanup();
  });
  beforeEach(async () => {
    await context.db.delete(activity);
  });

  it("replays a retained native FIT and preserves known metadata across sparse notification orderings", async () => {
    const fitBytes = await readFile(new URL("../../fit/fixtures/test.fit", import.meta.url));
    const endpoint = "https://r2.garmin-artifacts.test";
    const bucket = "imports";
    const file = {
      userId: "garmin-owner",
      summaryId: "file-summary-not-the-activity-id",
      activityId: 987654321,
      activityType: "CYCLING",
      startTimeInSeconds: Date.parse("2015-10-12T15:47:45.000Z") / 1000,
      fileType: "FIT",
      callbackURL:
        "https://apis.garmin.com/wellness-api/rest/activityFile?id=single-use-native-fit",
    };
    const artifactId = createHash("sha256").update(file.callbackURL).digest("hex");
    const key = `provider-artifacts/${TEST_USER_ID}/garmin/${artifactId}.fit`;
    let archived: ArrayBuffer | undefined;
    let garminDownloads = 0;
    let archiveHeads = 0;
    let archiveWrites = 0;
    let archiveReads = 0;
    server.use(
      http.get("https://apis.garmin.com/wellness-api/rest/activityFile", ({ request }) => {
        garminDownloads += 1;
        if (garminDownloads > 1) return new HttpResponse(null, { status: 410 });
        expect(request.headers.get("Authorization")).toBe("Bearer official-access");
        return new HttpResponse(new Uint8Array(fitBytes).buffer);
      }),
      http.head(`${endpoint}/${bucket}/${key}`, () => {
        archiveHeads += 1;
        return new HttpResponse(null, {
          status: archived ? 200 : 404,
          headers: archived ? { "Content-Length": String(archived.byteLength) } : {},
        });
      }),
      http.put(`${endpoint}/${bucket}/${key}`, async ({ request }) => {
        archiveWrites += 1;
        archived = await request.arrayBuffer();
        expect(Buffer.from(archived)).toEqual(fitBytes);
        return new HttpResponse(null, { headers: { ETag: '"retained-fit"' } });
      }),
      http.get(`${endpoint}/${bucket}/${key}`, () => {
        archiveReads += 1;
        if (!archived) return new HttpResponse(null, { status: 404 });
        return new HttpResponse(archived, {
          headers: { "Content-Length": String(archived.byteLength) },
        });
      }),
    );
    const client = new S3Client({
      endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: { accessKeyId: "test-r2-key", secretAccessKey: "test-r2-secret" },
    });
    const capture = createCapturingMetricStreamPublisher();
    const options = { userId: TEST_USER_ID, metricStreamPublisher: capture.publisher };
    const nativeDependencies = {
      artifacts: new R2ProviderArtifactStorage(client, bucket),
      fetchFn: globalThis.fetch,
      accessToken: "official-access",
    };
    const knownSummary = {
      ...summary,
      activityId: file.activityId,
      activityType: "CYCLING",
      activityName: "Morning ride",
      deviceName: "Edge 1050",
      summaryId: "manual-summary-before-file",
      startTimeInSeconds: file.startTimeInSeconds,
      durationInSeconds: 3290,
      manual: true,
    };
    await syncGarminActivityRecord(
      context.db,
      "manuallyUpdatedActivities",
      knownSummary,
      options,
      nativeDependencies,
    );
    const [original] = await context.db.select().from(activity);
    await context.db.execute(
      `CREATE FUNCTION fitness.reject_first_garmin_fit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Transient Garmin FIT activity write failure'; END $$`,
    );
    await context.db.execute(
      `CREATE TRIGGER reject_first_garmin_fit BEFORE INSERT ON fitness.activity FOR EACH ROW EXECUTE FUNCTION fitness.reject_first_garmin_fit()`,
    );
    try {
      await expect(
        syncGarminActivityRecord(context.db, "activityFiles", file, options, nativeDependencies),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: "Transient Garmin FIT activity write failure" }),
      });
      expect(archiveWrites).toBe(1);
      expect(Buffer.from(archived ?? new ArrayBuffer(0))).toEqual(fitBytes);
      const unchanged = await context.db.select().from(activity);
      expect(unchanged).toHaveLength(1);
      expect(unchanged[0]).toMatchObject({
        id: original?.id,
        name: "Morning ride",
        sourceName: "Edge 1050",
        raw: knownSummary,
      });
      expect(capture.publishedMetricStreamRows).toHaveLength(0);
      await context.db.execute(`DROP TRIGGER reject_first_garmin_fit ON fitness.activity`);

      await expect(
        syncGarminActivityRecord(context.db, "activityFiles", file, options, nativeDependencies),
      ).resolves.toBe(1);
      const rows = await context.db.select().from(activity);
      expect(rows).toHaveLength(1);
      const saved = rows[0];
      expect(saved).toMatchObject({
        id: original?.id,
        userId: TEST_USER_ID,
        providerId: "garmin",
        externalId: "987654321",
        canonicalType: "cycling",
        providerType: "CYCLING",
        name: "Morning ride",
        sourceName: "Edge 1050",
        raw: { ...file, manual: true },
        startedAt: new Date("2015-10-12T15:47:45.000Z"),
      });
      const power = capture.publishedMetricStreamRows.filter((row) => row.channel === "power");
      expect(power).toHaveLength(3226);
      expect(power[0]).toMatchObject({
        userId: TEST_USER_ID,
        providerId: "garmin",
        activityId: saved?.id,
        scalar: 26,
        recordedAt: "2015-10-12T15:47:45.000Z",
        sourceType: "file",
      });
      expect(
        capture.publishedMetricStreamRows.find((row) => row.channel === "cadence"),
      ).toMatchObject({
        activityId: saved?.id,
        scalar: 56,
        recordedAt: "2015-10-12T15:47:45.000Z",
      });
      expect(
        capture.publishedMetricStreamRows.every(
          (row) =>
            row.activityId === saved?.id &&
            row.userId === TEST_USER_ID &&
            row.providerId === "garmin",
        ),
      ).toBe(true);
      expect(garminDownloads).toBe(1);
      expect(archiveHeads).toBe(2);
      expect(archiveWrites).toBe(1);
      expect(archiveReads).toBe(2);

      const sparseSummary = {
        userId: file.userId,
        summaryId: "summary-after-file",
        activityId: file.activityId,
        activityType: file.activityType,
        startTimeInSeconds: file.startTimeInSeconds,
        durationInSeconds: 3400,
      };
      await syncGarminActivityRecord(
        context.db,
        "activities",
        sparseSummary,
        options,
        nativeDependencies,
      );
      const corrected = await context.db.select().from(activity);
      expect(corrected).toHaveLength(1);
      expect(corrected[0]).toMatchObject({
        id: original?.id,
        name: "Morning ride",
        sourceName: "Edge 1050",
        raw: { ...sparseSummary, manual: true },
        endedAt: new Date((file.startTimeInSeconds + 3400) * 1000),
      });

      const fileFirst = { ...file, activityId: 987654322, deviceName: "fēnix 8 – 47mm" };
      await syncGarminActivityRecord(
        context.db,
        "activityFiles",
        fileFirst,
        options,
        nativeDependencies,
      );
      const [fileFirstSaved] = await context.db
        .select()
        .from(activity)
        .where(eq(activity.externalId, "987654322"));
      expect(fileFirstSaved).toMatchObject({
        sourceName: "fēnix 8 – 47mm",
        raw: fileFirst,
      });
      await syncGarminActivityRecord(
        context.db,
        "activities",
        { ...sparseSummary, activityId: 987654322 },
        options,
        nativeDependencies,
      );
      const [sparseCorrected] = await context.db
        .select()
        .from(activity)
        .where(eq(activity.externalId, "987654322"));
      expect(sparseCorrected).toMatchObject({
        id: fileFirstSaved?.id,
        sourceName: "fēnix 8 – 47mm",
        raw: { ...sparseSummary, activityId: 987654322 },
      });
      const manualCorrection = {
        ...sparseSummary,
        activityId: 987654322,
        deviceName: "unknown",
        manual: true,
      };
      await syncGarminActivityRecord(
        context.db,
        "manuallyUpdatedActivities",
        manualCorrection,
        options,
        nativeDependencies,
      );
      const [manuallyCorrected] = await context.db
        .select()
        .from(activity)
        .where(eq(activity.externalId, "987654322"));
      expect(manuallyCorrected).toMatchObject({
        id: fileFirstSaved?.id,
        sourceName: "fēnix 8 – 47mm",
        raw: manualCorrection,
      });
      const revisedFile = { ...fileFirst, deviceName: "Forerunner 965" };
      await syncGarminActivityRecord(
        context.db,
        "activityFiles",
        revisedFile,
        options,
        nativeDependencies,
      );
      const [reprocessed] = await context.db
        .select()
        .from(activity)
        .where(eq(activity.externalId, "987654322"));
      expect(reprocessed).toMatchObject({
        id: fileFirstSaved?.id,
        sourceName: "Forerunner 965",
        raw: { ...revisedFile, manual: true },
      });
      expect(garminDownloads).toBe(1);
      expect(archiveWrites).toBe(1);
    } finally {
      await context.db.execute(
        `DROP TRIGGER IF EXISTS reject_first_garmin_fit ON fitness.activity`,
      );
      await context.db.execute(`DROP FUNCTION fitness.reject_first_garmin_fit()`);
      client.destroy();
    }
  });

  it("updates the same activity by activityId when summaryId changes", async () => {
    await syncGarminActivityRecord(
      context.db,
      "activities",
      summary,
      { userId: TEST_USER_ID },
      dependencies,
    );
    const corrected = {
      ...summary,
      summaryId: "summary-corrected",
      activityName: "Corrected run",
      durationInSeconds: 2000,
    };
    await syncGarminActivityRecord(
      context.db,
      "activities",
      corrected,
      { userId: TEST_USER_ID },
      dependencies,
    );
    const rows = await context.db.select().from(activity);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: TEST_USER_ID,
      providerId: "garmin",
      externalId: "1234567890",
      canonicalType: "running",
      providerType: "RUNNING",
      name: "Corrected run",
      raw: corrected,
      startUtcOffsetMinutes: null,
      rejectedProviderStartUtcOffsetMinutes: -420,
    });
    expect(rows[0]?.startedAt).toEqual(new Date(summary.startTimeInSeconds * 1000));
    expect(rows[0]?.endedAt).toEqual(new Date((summary.startTimeInSeconds + 2000) * 1000));
  });

  it("applies a manual correction to the original activity while preserving manual provenance", async () => {
    await syncGarminActivityRecord(
      context.db,
      "activities",
      summary,
      { userId: TEST_USER_ID },
      dependencies,
    );
    const corrected = {
      ...summary,
      summaryId: "manual-third-party-summary",
      activityType: "TRAIL_RUNNING",
      activityName: "Imported trail run",
      manual: true,
    };
    await syncGarminActivityRecord(
      context.db,
      "manuallyUpdatedActivities",
      corrected,
      { userId: TEST_USER_ID },
      dependencies,
    );
    const rows = await context.db.select().from(activity);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: "1234567890",
      canonicalType: "running",
      providerType: "TRAIL_RUNNING",
      modality: null,
      name: "Imported trail run",
      raw: corrected,
    });
  });

  it("uses summaryId for documented manual records without activityId", async () => {
    const { activityId: _activityId, ...manual } = summary;
    await syncGarminActivityRecord(
      context.db,
      "manuallyUpdatedActivities",
      manual,
      { userId: TEST_USER_ID },
      dependencies,
    );
    const [row] = await context.db.select().from(activity);
    expect(row).toMatchObject({ externalId: "summary-first", raw: manual });
  });

  it("keeps identical Garmin activity IDs isolated between Dofek owners", async () => {
    const otherUserId = "00000000-0000-0000-0000-000000000002";
    await context.db
      .insert(userProfile)
      .values({ id: otherUserId, name: "Second owner" })
      .onConflictDoNothing();
    await syncGarminActivityRecord(
      context.db,
      "activities",
      summary,
      { userId: TEST_USER_ID },
      dependencies,
    );
    await syncGarminActivityRecord(
      context.db,
      "activities",
      { ...summary, activityName: "Second user's run", manual: undefined },
      { userId: otherUserId },
      dependencies,
    );
    const rows = await context.db.select().from(activity);
    expect(rows).toHaveLength(2);
    const [first] = await context.db
      .select()
      .from(activity)
      .where(and(eq(activity.userId, TEST_USER_ID), eq(activity.externalId, "1234567890")));
    expect(first?.name).toBe("Morning run");
    const [second] = rows.filter((row) => row.userId === otherUserId);
    expect(second?.name).toBe("Second user's run");
    expect(second?.raw).not.toHaveProperty("manual");
  });
});
