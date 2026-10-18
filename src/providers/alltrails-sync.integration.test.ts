import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activity } from "../db/schema/activity.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { oauthToken } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { isEncryptedCredentialValue } from "../security/credential-encryption.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { AllTrailsProvider } from "./alltrails.ts";
import { allTrailsRecording } from "./alltrails-test-helpers.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";

const API = "https://api-v5.alltrails.com";
const server = setupServer();
const capture = createCapturingMetricStreamPublisher();

describe("AllTrails account sync", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(context.db, "alltrails", "AllTrails", API, TEST_USER_ID);
  }, 60_000);

  beforeEach(async () => {
    vi.stubEnv("ALLTRAILS_API_KEY", "test-app-key");
    vi.stubEnv("ALLTRAILS_CLIENT_ID", "test-client-id");
    capture.publishedMetricStreamRows.length = 0;
    capture.deletedMetricStreamScopes.length = 0;
    await context.db.delete(activity).where(eq(activity.providerId, "alltrails"));
    await saveTokens(
      context.db,
      "alltrails",
      {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: null,
        providerAccountId: "123",
      },
      TEST_USER_ID,
    );
    server.use(
      http.get(`${API}/api/alltrails/maps/:id`, ({ request, params }) => {
        expect(new URL(request.url).searchParams.get("combine_segments")).toBe("false");
        return HttpResponse.json({ maps: [allTrailsRecording(Number(params.id))] });
      }),
    );
  });

  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    server.close();
    if (context) await context.cleanup();
  });

  function run() {
    return new AllTrailsProvider().sync(
      new SyncRun({
        db: context.db,
        userId: TEST_USER_ID,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-10-10", untilDate: "2026-10-10" }),
        metricStreamPublisher: capture.publisher,
      }),
    );
  }

  function history(ids: number[]) {
    server.use(
      http.get(`${API}/api/alltrails/users/123/maps`, () =>
        HttpResponse.json({
          maps: ids.map((id) => ({ id })),
          pageInfo: { hasNextPage: false, nextCursor: null },
        }),
      ),
    );
  }

  it("stores raw recording facts and timed sensor channels across source segments", async () => {
    history([101]);
    const result = await run();
    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBeGreaterThan(0);
    const rows = await context.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "alltrails"));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      externalId: "101",
      userId: TEST_USER_ID,
      name: "Morning hike 101",
      canonicalType: "hiking",
      timezone: "America/Los_Angeles",
      startedAt: new Date("2026-10-10T17:00:00Z"),
      endedAt: new Date("2026-10-10T17:05:15.500Z"),
      raw: allTrailsRecording(101),
    });
    const locations = capture.publishedMetricStreamRows.filter(
      (sample) => sample.channel === "location",
    );
    const elevations = capture.publishedMetricStreamRows.filter(
      (sample) => sample.channel === "altitude",
    );
    expect(locations).toHaveLength(4);
    expect(elevations).toHaveLength(4);
    expect(locations.map((sample) => sample.recordedAt)).toEqual([
      "2026-10-10T17:00:00.000Z",
      "2026-10-10T17:00:10.250Z",
      "2026-10-10T17:05:00.000Z",
      "2026-10-10T17:05:15.500Z",
    ]);
    expect(
      locations.every((sample) => sample.activityId === row?.id && sample.userId === TEST_USER_ID),
    ).toBe(true);
    expect(new Set(locations.map((sample) => sample.externalId)).size).toBe(4);
    expect(locations[0]?.point).toBe("SRID=4326;POINT(-122.45 37.75)");
    expect(elevations.map((sample) => sample.scalar)).toEqual([12.5, 13.25, 14, 13.75]);
  });

  it("refreshes and encrypts rotated credentials before reading every history page", async () => {
    await saveTokens(
      context.db,
      "alltrails",
      {
        accessToken: "expired",
        refreshToken: "refresh-old",
        expiresAt: new Date(0),
        scopes: null,
        providerAccountId: "123",
      },
      TEST_USER_ID,
    );
    server.use(
      http.post(`${API}/identity/oauth/token`, async ({ request }) => {
        expect(await request.json()).toEqual({
          client_id: "test-client-id",
          grant_type: "refresh_token",
          refresh_token: "refresh-old",
        });
        return HttpResponse.json({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        });
      }),
    );
    const cursors: (string | null)[] = [];
    server.use(
      http.get(`${API}/api/alltrails/users/123/maps`, async ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("after");
        cursors.push(cursor);
        expect(request.headers.get("X-AT-AUTH-TOKEN")).toBe("access-new");
        expect(request.headers.get("X-AT-CLIENT-ID")).toBe("test-client-id");
        expect((await loadTokens(context.db, "alltrails", TEST_USER_ID))?.refreshToken).toBe(
          "refresh-new",
        );
        return HttpResponse.json({
          maps: [{ id: cursor ? 102 : 101 }],
          pageInfo: { hasNextPage: !cursor, nextCursor: cursor ? null : "page-two" },
        });
      }),
    );
    const before = Date.now();
    expect((await run()).errors).toEqual([]);
    expect(cursors).toEqual([null, "page-two"]);
    const stored = await loadTokens(context.db, "alltrails", TEST_USER_ID);
    expect(stored).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      providerAccountId: "123",
    });
    expect(stored?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
    const [ciphertext] = await context.db
      .select()
      .from(oauthToken)
      .where(and(eq(oauthToken.providerId, "alltrails"), eq(oauthToken.userId, TEST_USER_ID)));
    if (!ciphertext?.accessToken || !ciphertext.refreshToken) {
      throw new Error("Expected stored AllTrails access and refresh credentials");
    }
    expect(isEncryptedCredentialValue(ciphertext.accessToken)).toBe(true);
    expect(isEncryptedCredentialValue(ciphertext.refreshToken)).toBe(true);
  });

  it("upserts recordings and reconciles absence only after the full list completes", async () => {
    history([101, 102]);
    expect((await run()).errors).toEqual([]);
    history([101]);
    expect((await run()).errors).toEqual([]);
    const rows = await context.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "alltrails"));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.externalId === "101")?.providerAbsentAt).toBeNull();
    expect(rows.find((row) => row.externalId === "102")?.providerAbsentAt).toBeInstanceOf(Date);
  });

  it("keeps private recordings visible across paginated history", async () => {
    history([101, 102]);
    expect((await run()).errors).toEqual([]);
    const privateFlags: (string | null)[] = [];
    server.use(
      http.get(`${API}/api/alltrails/users/123/maps`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        privateFlags.push(query.get("allow_private"));
        const secondPage = query.has("after");
        return HttpResponse.json({
          maps: secondPage
            ? query.get("allow_private") === "true"
              ? [{ id: 102 }]
              : []
            : [{ id: 101 }],
          pageInfo: { hasNextPage: !secondPage, nextCursor: secondPage ? null : "private-page" },
        });
      }),
    );
    expect((await run()).errors).toEqual([]);
    expect(privateFlags).toEqual(["true", "true"]);
    const [privateRecording] = await context.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "alltrails"), eq(activity.externalId, "102")));
    expect(privateRecording?.providerAbsentAt).toBeNull();
  });

  it("keeps existing recordings visible when a later history page fails", async () => {
    history([101, 102]);
    expect((await run()).errors).toEqual([]);
    server.use(
      http.get(`${API}/api/alltrails/users/123/maps`, ({ request }) => {
        if (new URL(request.url).searchParams.has("after"))
          return new HttpResponse(null, { status: 502 });
        return HttpResponse.json({
          maps: [{ id: 101 }],
          pageInfo: { hasNextPage: true, nextCursor: "page-two" },
        });
      }),
    );
    const result = await run();
    expect(result.errors.length).toBeGreaterThan(0);
    const [missingFromPartialList] = await context.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "alltrails"), eq(activity.externalId, "102")));
    expect(missingFromPartialList?.providerAbsentAt).toBeNull();
  });
});
