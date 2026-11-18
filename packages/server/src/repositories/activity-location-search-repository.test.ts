import { captureException } from "dofek/lib/error-reporting";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import { ActivityLocationSearchRepository } from "./activity-location-search-repository.ts";

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

const userId = "10000000-0000-4000-8000-000000000001";
const timezone = "America/Los_Angeles";
const fullAccess = { kind: "full", paid: true, reason: "paid_grant" } as const;
const nearby = { kind: "nearby", latitude: 37.8, longitude: -122.3 } as const;

it("binds nearby search to the account, sport, history window, and page position", async () => {
  const after = {
    id: "10000000-0000-4000-8000-000000000002",
    startedAt: "2026-03-16T10:00:00.123456Z",
  };
  const match = {
    id: "10000000-0000-4000-8000-000000000003",
    startedAt: "2026-03-15T10:00:00.123456Z",
  };
  const sensorStore = makeMockSensorStore([match]);
  const postgres = { execute: vi.fn() };
  const repository = new ActivityLocationSearchRepository(postgres, userId, timezone, sensorStore, {
    kind: "limited",
    paid: false,
    reason: "free_recent_week",
    startDate: "2026-03-10",
    endDateExclusive: "2026-03-17",
  });

  await expect(
    repository.findCandidates({ location: nearby, activityType: "running", after, limit: 21 }),
  ).resolves.toEqual([match]);
  expect(vi.mocked(sensorStore.query).mock.lastCall?.[2]).toEqual({
    userId,
    latitude: 37.8,
    longitude: -122.3,
    distance: 25_000,
    limit: 21,
    timezone,
    startDate: "2026-03-10",
    endDateExclusive: "2026-03-17",
    activityType: "running",
    cursorStartedAt: "2026-03-16T10:00:00.123456Z",
    cursorId: "10000000-0000-4000-8000-000000000002",
  });
  expect(postgres.execute).not.toHaveBeenCalled();
});

it("binds only the proximity and account parameters for the first full-history page", async () => {
  const sensorStore = makeMockSensorStore();
  const repository = new ActivityLocationSearchRepository(
    { execute: vi.fn() },
    userId,
    timezone,
    sensorStore,
    fullAccess,
  );

  await expect(repository.findCandidates({ location: nearby, limit: 4 })).resolves.toEqual([]);
  expect(vi.mocked(sensorStore.query).mock.lastCall?.[2]).toEqual({
    userId,
    latitude: 37.8,
    longitude: -122.3,
    distance: 25_000,
    limit: 4,
  });
});

it("reports a named search failure without exposing its SQL parameters or database error", async () => {
  const name = "Private gym";
  const problem = Object.assign(new Error(`Invalid data for ${name}`), { code: "22000" });
  const repository = new ActivityLocationSearchRepository(
    { execute: vi.fn().mockRejectedValue(new DrizzleQueryError("SELECT $1", [name], problem)) },
    userId,
    timezone,
    makeMockSensorStore(),
    fullAccess,
  );

  await expect(
    repository.findCandidates({ location: { kind: "name", name }, limit: 1 }),
  ).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
    message: "Location search is temporarily unavailable.",
  });
  expect(captureException).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: "Named activity location search failed." }),
    { tags: { dependency: "postgres", databaseCode: "22000" } },
  );
  const [reportedError] = vi.mocked(captureException).mock.lastCall ?? [];
  expect(reportedError).not.toHaveProperty("cause");
});

it.each([
  { label: "a non-error rejection", error: "unexpected response" },
  { label: "an error with no cause", error: new Error("unexpected response") },
  { label: "a non-error cause", error: new Error("query failure", { cause: { code: "22000" } }) },
  { label: "a cause with no code", error: new Error("query failure", { cause: new Error() }) },
  {
    label: "a cause with a non-string code",
    error: new Error("query failure", { cause: Object.assign(new Error(), { code: 22 }) }),
  },
])("reports a safe named search error for $label", async ({ error }) => {
  const repository = new ActivityLocationSearchRepository(
    { execute: vi.fn().mockRejectedValue(error) },
    userId,
    timezone,
    makeMockSensorStore(),
    fullAccess,
  );

  await expect(
    repository.findCandidates({ location: { kind: "name", name: "Gym" }, limit: 1 }),
  ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(captureException).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: "Named activity location search failed." }),
    { tags: { dependency: "postgres", databaseCode: undefined } },
  );
});
