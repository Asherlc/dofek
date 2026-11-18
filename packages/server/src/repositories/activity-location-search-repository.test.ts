import { captureException } from "dofek/lib/error-reporting";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import { ActivityLocationSearchRepository } from "./activity-location-search-repository.ts";

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

it("reports a named search failure without exposing its SQL parameters or database error", async () => {
  const name = "Private gym";
  const problem = Object.assign(new Error(`Invalid data for ${name}`), { code: "22000" });
  const repository = new ActivityLocationSearchRepository(
    { execute: vi.fn().mockRejectedValue(new DrizzleQueryError("SELECT $1", [name], problem)) },
    "10000000-0000-4000-8000-000000000001",
    "UTC",
    makeMockSensorStore(),
    { kind: "full", paid: true, reason: "paid_grant" },
  );

  await expect(
    repository.findCandidates({ location: { kind: "name", name }, limit: 1 }),
  ).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
    message: "Location search is temporarily unavailable.",
  });
  expect(captureException).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Named activity location search failed." }),
    { tags: { dependency: "postgres", databaseCode: "22000" } },
  );
  const [reportedError] = vi.mocked(captureException).mock.lastCall ?? [];
  expect(reportedError).not.toHaveProperty("cause");
});
