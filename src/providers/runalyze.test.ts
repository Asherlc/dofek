import { PgDialect } from "drizzle-orm/pg-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { runningRaceResult } from "../db/schema/activity.ts";
import { authFailureReasonFromError } from "./auth-errors.ts";
import { RunalyzeProvider } from "./runalyze.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

const server = setupServer();
const endpoint = "https://runalyze.com/api/v1/raceresult";
const activities = "https://runalyze.com/api/v1/activity";
const exchange = new RunalyzeProvider().authSetup().manualToken.exchangeToken;
const userId = "00000000-0000-4000-8000-000000000001";
const race = {
  activity_id: 1,
  date: "2026-05-01T00:30:00+02:00",
  name: "Spring 5K",
  official_distance: 5,
  official_time: 1500.25,
  status: "completed",
};
const runningActivity = { id: 1, sport: { name: "RUNNING" }, is_virtual: false };
const token = {
  accessToken: "test-token",
  refreshToken: null,
  expiresAt: new Date("2099-12-31T00:00:00.000Z"),
  scopes: "self",
};

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("validates a personal token using a bounded JSON collection request", async () => {
  server.use(
    http.get(endpoint, ({ request }) => {
      expect(request.headers.get("token")).toBe("test-token");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(new URL(request.url).searchParams.get("itemsPerPage")).toBe("1");
      return HttpResponse.json([]);
    }),
  );
  await expect(exchange("test-token")).resolves.toMatchObject({ accessToken: "test-token" });
});

it.each([401, 403])("reports rejected personal tokens (%s)", async (status) => {
  server.use(http.get(endpoint, () => new HttpResponse(null, { status })));
  await expect(exchange("test-token")).rejects.toThrow(/Runalyze rejected/);
});

function syncFixture(tokensResult = [token]) {
  const { db, spies } = createMockDatabase({ tokensResult });
  const transaction = vi.spyOn(db, "transaction");
  const sync = () =>
    new RunalyzeProvider().sync(
      new SyncRun({
        db,
        userId,
        window: SyncWindow.fromSince({ since: new Date("2026-11-01T00:00:00Z") }),
      }),
    );
  return { sync, spies, transaction };
}

it("replaces the owner snapshot from both pages using only attributable running finishes", async () => {
  const { sync, spies, transaction } = syncFixture();
  const firstPage = [
    race,
    { ...race, activity_id: 2, date: "" },
    { ...race, activity_id: 3, official_distance: null },
    { ...race, activity_id: 4, official_distance: 0 },
    { ...race, activity_id: 5, official_time: null },
    { ...race, activity_id: 6, official_time: 0 },
    { ...race, activity_id: 0 },
    { ...race, activity_id: null },
    ...Array.from({ length: 92 }, (_, index) => ({
      ...race,
      activity_id: 100 + index,
      status: "dnf",
    })),
  ];
  const secondPage = [7, 8, 9, 10, 11].map((activity_id) => ({ ...race, activity_id }));
  const requestedPages: (string | null)[] = [];
  server.use(
    http.get(endpoint, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(request.headers.get("token")).toBe("test-token");
      expect(params.get("order[activity.time]")).toBe("asc");
      expect(params.get("itemsPerPage")).toBe("100");
      requestedPages.push(params.get("page"));
      return HttpResponse.json(params.get("page") === "1" ? firstPage : secondPage);
    }),
    http.get(activities, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("id")).toBe("1,7,8,9,10,11");
      expect(params.get("itemsPerPage")).toBe("6");
      expect(transaction).not.toHaveBeenCalled();
      return HttpResponse.json([
        runningActivity,
        { ...runningActivity, id: 7, sport: { name: "Cycling" } },
        { ...runningActivity, id: 8, is_virtual: true },
        { id: 9, sport: { name: "Running" } },
        { ...runningActivity, id: 10, sport: { name: "Running" } },
        { id: 11, is_virtual: false },
      ]);
    }),
  );
  await expect(sync()).resolves.toMatchObject({
    provider: "runalyze",
    recordsSynced: 2,
    errors: [],
  });
  expect(requestedPages).toEqual(["1", "2"]);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(spies.deleteFn).toHaveBeenCalledExactlyOnceWith(runningRaceResult);
  expect(new PgDialect().sqlToQuery(spies.deleteWhere.mock.calls[0]?.[0]).params).toEqual([
    userId,
    "runalyze",
  ]);
  const expectedFinish = {
    userId,
    providerId: "runalyze",
    sourceName: race.name,
    sourceDateTime: race.date,
    distanceMeters: 5000,
    finishSeconds: 1500.25,
  };
  expect(spies.values).toHaveBeenCalledWith([
    { ...expectedFinish, sourceActivityId: "1", sourceSport: "RUNNING" },
    { ...expectedFinish, sourceActivityId: "10", sourceSport: "Running" },
  ]);
});

it.each([
  {
    response: () => HttpResponse.json([{ ...race, official_time: "bad" }]),
    message: "malformed raceresult",
  },
  { response: () => HttpResponse.json([race, race]), message: "duplicate race activity IDs" },
  {
    response: () => HttpResponse.json([], { status: 206 }),
    message: "raceresult request failed (206)",
  },
])("preserves the snapshot when the API returns $message", async ({ response, message }) => {
  const { sync, spies, transaction } = syncFixture();
  server.use(http.get(endpoint, response));
  await expect(sync()).resolves.toMatchObject({
    recordsSynced: 0,
    errors: [{ message: expect.stringContaining(message) }],
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(spies.deleteFn).not.toHaveBeenCalled();
});

it("preserves the snapshot when a successful linked lookup omits a requested activity", async () => {
  const { sync, spies, transaction } = syncFixture();
  server.use(
    http.get(endpoint, () => HttpResponse.json([race, { ...race, activity_id: 2 }])),
    http.get(activities, ({ request }) => {
      expect(new URL(request.url).searchParams.get("id")).toBe("1,2");
      return HttpResponse.json([runningActivity]);
    }),
  );
  await expect(sync()).resolves.toMatchObject({
    recordsSynced: 0,
    errors: [{ message: "Runalyze omitted requested linked activities." }],
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(spies.deleteFn).not.toHaveBeenCalled();
});

it("preserves the existing snapshot when linked lookup rejects the owner token", async () => {
  const { sync, spies, transaction } = syncFixture();
  server.use(
    http.get(endpoint, () => HttpResponse.json([race])),
    http.get(activities, () => new HttpResponse(null, { status: 403 })),
  );
  const result = await sync();
  expect(result.recordsSynced).toBe(0);
  expect(authFailureReasonFromError(result.errors[0]?.cause)).toBe("authentication_failed");
  expect(transaction).not.toHaveBeenCalled();
  expect(spies.deleteFn).not.toHaveBeenCalled();
  expect(spies.values).toHaveBeenCalledWith(
    expect.objectContaining({ userId, authFailureReason: "authentication_failed" }),
  );
});

it("clears the owner snapshot atomically after an empty complete inventory", async () => {
  const { sync, spies, transaction } = syncFixture();
  server.use(http.get(endpoint, () => HttpResponse.json([])));
  await expect(sync()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(spies.deleteFn).toHaveBeenCalledExactlyOnceWith(runningRaceResult);
  expect(spies.insert).not.toHaveBeenCalledWith(runningRaceResult);
});

it("requires the owner's stored token before fetching or modifying a snapshot", async () => {
  const { sync, transaction } = syncFixture([]);
  await expect(sync()).resolves.toMatchObject({
    recordsSynced: 0,
    errors: [{ message: "Connect Runalyze in Data Sources to sync race results." }],
  });
  expect(transaction).not.toHaveBeenCalled();
});
