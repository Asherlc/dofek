import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withAccountErasureDeliveryFence } from "./account-erasure-delivery-fence.ts";
import { createDatabase } from "./index.ts";

const database = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => database.$client.end());

const userA = "00000000-0000-4000-8000-000000000002";
const userB = "00000000-0000-4000-8000-000000000001";

describe("withAccountErasureDeliveryFence", () => {
  const transaction = database;
  const trace: string[] = [];

  beforeEach(() => {
    trace.length = 0;
    vi.spyOn(database, "execute").mockImplementation(async () => {
      trace.push("execute");
      return [];
    });
    vi.spyOn(database, "transaction").mockImplementation(async (work) => {
      trace.push("transaction");
      const result = await work(transaction);
      trace.push("release");
      return result;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("acquires sorted shared advisory locks then runs work before releasing the transaction", async () => {
    const seen: string[] = [];
    await withAccountErasureDeliveryFence(database, [userA, userB], async (fenced) => {
      seen.push(...fenced);
      trace.push("work");
      return "ok";
    });
    expect(trace).toEqual(["transaction", "execute", "execute", "execute", "work", "release"]);
    expect(seen).toEqual([]);
    expect(database.execute).toHaveBeenCalledTimes(3);
    const lockQueries = vi
      .mocked(database.execute)
      .mock.calls.slice(0, 2)
      .map(([query]) => query);
    expect(JSON.stringify(lockQueries[0])).toContain("pg_advisory_xact_lock_shared");
    expect(JSON.stringify(lockQueries[0])).toContain(userB);
    expect(JSON.stringify(lockQueries[1])).toContain(userA);
  });

  it("passes active/scrubbed fence rows to work as a lowercase set", async () => {
    vi.mocked(database.execute)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ user_id: userB }]);
    let fenced: ReadonlySet<string> = new Set();
    await withAccountErasureDeliveryFence(database, [userA, userB], async (ids) => {
      fenced = ids;
    });
    expect(fenced).toEqual(new Set([userB]));
  });

  it("still opens a transaction when there are no known user ids", async () => {
    await withAccountErasureDeliveryFence(database, [], async (fenced, connection) => {
      expect(fenced.size).toBe(0);
      expect(connection).toBe(transaction);
      trace.push("work");
    });
    expect(trace).toEqual(["transaction", "work", "release"]);
    expect(database.execute).not.toHaveBeenCalled();
  });
});
