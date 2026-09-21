import { describe, expect, it } from "vitest";
import type { SyncJobData } from "../../jobs/queues.ts";
import { syncApiQueryKey } from "../../lib/sync-api-query.ts";
import { resolveZivaSyncRequestQuery } from "./sync-request-query.ts";

const initialJobData: SyncJobData = {
  providerId: "ziva",
  userId: "user-1",
  sinceIso: "2026-09-01T00:00:00.000Z",
  untilIso: "2026-09-30T23:59:59.999Z",
};

const continuationJobData: SyncJobData = {
  ...initialJobData,
  checkpoint: {
    version: 1,
    nextDate: "2026-09-15",
    endDate: "2026-09-30",
    recordsSynced: 14,
  },
};

describe("resolveZivaSyncRequestQuery", () => {
  it("uses the first date in the initial planned chunk", () => {
    expect(resolveZivaSyncRequestQuery(initialJobData)).toEqual({
      path: "get_meals_for_date",
      filters: { start_date: "2026-09-01" },
    });
  });

  it("uses the checkpoint's next date for a continuation", () => {
    expect(resolveZivaSyncRequestQuery(continuationJobData)).toEqual({
      path: "get_meals_for_date",
      filters: { start_date: "2026-09-15" },
    });
  });

  it("does not include cumulative record counts in the request identity", () => {
    expect(
      resolveZivaSyncRequestQuery({
        ...continuationJobData,
        checkpoint: {
          version: 1,
          nextDate: "2026-09-15",
          endDate: "2026-09-30",
          recordsSynced: 999,
        },
      }),
    ).toEqual(resolveZivaSyncRequestQuery(continuationJobData));
  });

  it("gives the active parent and its continuation different request identities", () => {
    const initialQuery = resolveZivaSyncRequestQuery(initialJobData);
    const continuationQuery = resolveZivaSyncRequestQuery(continuationJobData);

    if (initialQuery === null || continuationQuery === null) {
      throw new Error("Expected initial and continuation Ziva request queries");
    }
    expect(syncApiQueryKey(initialQuery)).not.toBe(syncApiQueryKey(continuationQuery));
  });

  it("rejects malformed checkpoints", () => {
    expect(() =>
      resolveZivaSyncRequestQuery({
        ...initialJobData,
        checkpoint: { version: 1, nextDate: "not-a-date" },
      }),
    ).toThrow();
  });
});
