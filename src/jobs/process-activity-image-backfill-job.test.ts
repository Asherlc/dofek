import { describe, expect, it, vi } from "vitest";
import { processImageBackfillPage } from "./process-activity-image-backfill-job.ts";

describe("historical image backfill", () => {
  it("preserves the cursor before a failed discovery", async () => {
    const discover = vi
      .fn()
      .mockResolvedValueOnce({ coverage: "complete", images: [1, 2] })
      .mockRejectedValueOnce(Error("rate limited"))
      .mockResolvedValueOnce({ coverage: "unavailable", images: [] });
    const result = await processImageBackfillPage(
      [
        { id: "a", externalId: "1", startedAt: "2020-01-01T00:00:00Z" },
        { id: "b", externalId: "2", startedAt: "2020-01-01T00:00:00Z" },
        { id: "c", externalId: "3", startedAt: "2020-01-02T00:00:00Z" },
      ],
      discover,
    );
    expect(result).toMatchObject({
      scanned: 1,
      discovered: 2,
      failed: 0,
      cursor: { id: "a" },
      retryAfterSeconds: 300,
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it("handles an empty historical range without inventing a cursor", async () =>
    expect(await processImageBackfillPage([], vi.fn())).toEqual({
      scanned: 0,
      discovered: 0,
      failed: 0,
      cursor: null,
      retryAfterSeconds: 0,
    }));
});

it("stops before a transient failure and carries its retry deadline", async () => {
  const result = await processImageBackfillPage(
    [
      { id: "a", externalId: "1", startedAt: "2020-01-01" },
      { id: "b", externalId: "2", startedAt: "2020-01-02" },
      { id: "c", externalId: "3", startedAt: "2020-01-03" },
    ],
    vi.fn().mockResolvedValueOnce({ coverage: "complete", images: [] }).mockResolvedValueOnce({
      coverage: "partial",
      images: [],
      retryable: true,
      retryAfterSeconds: 900,
    }),
  );
  expect(result).toMatchObject({
    scanned: 1,
    cursor: { id: "a" },
    retryAfterSeconds: 900,
    failed: 0,
  });
});

vi.mock("../db/account-erasure.ts", () => ({
  AccountErasureUserFencedError: class Fenced extends Error {},
  withAccountErasureUserWriteFence: vi.fn(async (db, _user, work) => work(db)),
}));
vi.mock("../activity-images/providers.ts", async (original) => ({
  ...(await original<typeof import("../activity-images/providers.ts")>()),
  discoverAndRecordActivityImages: vi.fn(async () => ({
    coverage: "complete",
    images: [],
    expectedCount: 0,
    reason: null,
  })),
}));

const backfillRow = {
  id: "run",
  user_id: "owner",
  provider_id: "strava",
  cursor_started_at: null,
  cursor_id: null,
  high_water_at: new Date("2026-01-01"),
  scanned: 0,
  state: "queued",
};
async function backfillDatabase() {
  const { createMockDatabase } = await import("../providers/test-helpers.ts");
  return createMockDatabase();
}

it("resolves missing and existing backfill provider ownership", async () => {
  const { loadActivityImageBackfillProvider } = await import(
    "./process-activity-image-backfill-job.ts"
  );
  const { db, spies } = await backfillDatabase();
  spies.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ provider_id: "strava" }]);
  expect(await loadActivityImageBackfillProvider(db, "missing", "owner")).toBeUndefined();
  expect(await loadActivityImageBackfillProvider(db, "run", "owner")).toBe("strava");
});
it("dispatches only successfully claimed runs with recoverable Redis IDs", async () => {
  const { dispatchActivityImageBackfills } = await import(
    "./process-activity-image-backfill-job.ts"
  );
  const { db, spies } = await backfillDatabase();
  const queue = { add: vi.fn(async () => undefined) };
  spies.execute
    .mockResolvedValueOnce([backfillRow, { ...backfillRow, id: "lost" }])
    .mockResolvedValueOnce([{ id: "run" }])
    .mockResolvedValueOnce([]);
  await dispatchActivityImageBackfills(db, queue);
  expect(queue.add).toHaveBeenCalledExactlyOnceWith(
    "backfill",
    { backfillId: "run", userId: "owner" },
    { jobId: "activity-image-backfill-run-0", removeOnComplete: true, removeOnFail: true },
  );
});
it("continues past fenced runs but propagates other dispatch failures", async () => {
  const { dispatchActivityImageBackfills } = await import(
    "./process-activity-image-backfill-job.ts"
  );
  const { withAccountErasureUserWriteFence, AccountErasureUserFencedError } = await import(
    "../db/account-erasure.ts"
  );
  const { db, spies } = await backfillDatabase();
  const queue = { add: vi.fn(async () => undefined) };
  spies.execute.mockResolvedValue([backfillRow]);
  vi.mocked(withAccountErasureUserWriteFence).mockRejectedValueOnce(
    new AccountErasureUserFencedError("owner"),
  );
  await expect(dispatchActivityImageBackfills(db, queue)).resolves.toBeUndefined();
  expect(queue.add).not.toHaveBeenCalled();
  vi.mocked(withAccountErasureUserWriteFence).mockRejectedValueOnce(Error("database down"));
  await expect(dispatchActivityImageBackfills(db, queue)).rejects.toThrow("database down");
});
it.each([undefined, "pending"])(
  "ignores missing or unclaimed backfill jobs (%s)",
  async (state) => {
    const { processActivityImageBackfillJob } = await import(
      "./process-activity-image-backfill-job.ts"
    );
    const { db, spies } = await backfillDatabase();
    spies.execute.mockResolvedValueOnce(state ? [{ ...backfillRow, state }] : []);
    await processActivityImageBackfillJob(db, { userId: "owner", backfillId: "run" });
    expect(spies.execute).toHaveBeenCalledOnce();
  },
);
it("stops discovery after a provider disconnects", async () => {
  const { processActivityImageBackfillJob } = await import(
    "./process-activity-image-backfill-job.ts"
  );
  const { discoverAndRecordActivityImages } = await import("../activity-images/providers.ts");
  vi.mocked(discoverAndRecordActivityImages).mockClear();
  const { db, spies } = await backfillDatabase();
  spies.execute.mockResolvedValueOnce([backfillRow]).mockResolvedValueOnce([]);
  await processActivityImageBackfillJob(db, { userId: "owner", backfillId: "run" });
  expect(spies.execute).toHaveBeenCalledTimes(3);
  expect(discoverAndRecordActivityImages).not.toHaveBeenCalled();
});
it.each([0, 1, 100])(
  "checkpoints a page of %i activities through the owner fence",
  async (count) => {
    const { processActivityImageBackfillJob } = await import(
      "./process-activity-image-backfill-job.ts"
    );
    const { discoverAndRecordActivityImages } = await import("../activity-images/providers.ts");
    const { withAccountErasureUserWriteFence } = await import("../db/account-erasure.ts");
    vi.mocked(discoverAndRecordActivityImages).mockClear();
    vi.mocked(withAccountErasureUserWriteFence).mockClear();
    const { db, spies } = await backfillDatabase();
    const activities = Array.from({ length: count }, (_, i) => ({
      id: `activity-${i}`,
      external_id: `source-${i}`,
      started_at: "2020-01-01",
    }));
    spies.execute
      .mockResolvedValueOnce([backfillRow])
      .mockResolvedValueOnce([{ provider_id: "strava" }])
      .mockResolvedValueOnce(activities)
      .mockResolvedValueOnce([]);
    await processActivityImageBackfillJob(db, { userId: "owner", backfillId: "run" });
    expect(discoverAndRecordActivityImages).toHaveBeenCalledTimes(count);
    expect(withAccountErasureUserWriteFence).toHaveBeenCalledWith(
      db,
      "owner",
      expect.any(Function),
    );
    if (count)
      expect(discoverAndRecordActivityImages).toHaveBeenCalledWith(
        expect.objectContaining({ options: expect.objectContaining({ userId: "owner" }) }),
        "activity-0",
        "source-0",
        "strava",
      );
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const query = spies.execute.mock.calls.at(-1)?.[0];
    if (!query) throw Error("Missing checkpoint");
    expect(new PgDialect().sqlToQuery(query).params).toContain(
      count === 100 ? "pending" : "completed",
    );
  },
);
it("starts a scoped backfill and reports provider-wide storage counts", async () => {
  const { startActivityImageBackfill, getActivityImageBackfillProgress } = await import(
    "./process-activity-image-backfill-job.ts"
  );
  const { db, spies } = await backfillDatabase();
  spies.execute
    .mockResolvedValueOnce([{ id: "run" }])
    .mockResolvedValueOnce([{ id: "other" }])
    .mockResolvedValueOnce([
      {
        id: "run",
        provider_id: "strava",
        state: "completed",
        scanned: 5,
        discovered: 4,
        failed: 1,
        stored: "3",
        coverage: { partial: 1 },
      },
    ]);
  expect(await startActivityImageBackfill(db, "owner", "strava")).toEqual(["run"]);
  expect(await startActivityImageBackfill(db, "owner")).toEqual(["other"]);
  expect(await getActivityImageBackfillProgress(db, "owner", "run")).toMatchObject([
    { stored: 3, coverage: { partial: 1 } },
  ]);
});
it("advances after permanent failures and retries failed discovery without an explicit hint", async () => {
  const activities = [{ id: "a", externalId: "a", startedAt: "2020-01-01" }];
  expect(
    await processImageBackfillPage(activities, async () => ({
      coverage: "failed",
      images: [],
      retryable: false,
    })),
  ).toMatchObject({ scanned: 1, failed: 1, retryAfterSeconds: 0 });
  expect(
    await processImageBackfillPage(activities, async () => ({ coverage: "failed", images: [] })),
  ).toMatchObject({ scanned: 0, failed: 0, retryAfterSeconds: 300 });
  expect(
    await processImageBackfillPage(activities, async () => {
      throw { statusCode: 404 };
    }),
  ).toMatchObject({ scanned: 1, failed: 1, retryAfterSeconds: 0 });
});

it("counts a partial activity only when its cursor advances", async () => {
  const activities = [{ id: "a", externalId: "a", startedAt: "2020-01-01" }];
  const discovery = { coverage: "partial" as const, images: [], retryable: true };
  expect(await processImageBackfillPage(activities, async () => discovery)).toMatchObject({
    scanned: 0,
    discovered: 0,
    failed: 0,
  });
  expect(
    await processImageBackfillPage(activities, async () => ({ ...discovery, retryable: false })),
  ).toMatchObject({ scanned: 1, failed: 1 });
});
