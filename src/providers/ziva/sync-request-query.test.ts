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
    sourceAccountKey: "opaque-source-account-key",
    nextDate: "2026-09-15",
    endDate: "2026-09-30",
    recordsSynced: 14,
  },
};

describe("resolveZivaSyncRequestQuery", () => {
  it("identifies the complete initial requested window without claiming UTC dates are diary dates", () => {
    expect(resolveZivaSyncRequestQuery(initialJobData)).toEqual({
      path: "ziva-diary-chunk",
      filters: {
        checkpoint_end_date: null,
        next_date: null,
        origin: null,
        requested_at_iso: null,
        source_account_key: null,
        window_kind: "bounded",
        window_since_iso: "2026-09-01T00:00:00.000Z",
        window_until_iso: "2026-09-30T23:59:59.999Z",
      },
    });
  });

  it("includes the account-bound checkpoint scope for a continuation", () => {
    expect(resolveZivaSyncRequestQuery(continuationJobData)).toEqual({
      path: "ziva-diary-chunk",
      filters: {
        checkpoint_end_date: "2026-09-30",
        next_date: "2026-09-15",
        origin: null,
        requested_at_iso: null,
        source_account_key: "opaque-source-account-key",
        window_kind: "bounded",
        window_since_iso: "2026-09-01T00:00:00.000Z",
        window_until_iso: "2026-09-30T23:59:59.999Z",
      },
    });
  });

  it("uses a continuation checkpoint whose calendar end differs from the UTC window", () => {
    expect(
      resolveZivaSyncRequestQuery({
        ...continuationJobData,
        untilIso: "2026-10-01T06:30:00.000Z",
      }),
    ).toMatchObject({
      filters: {
        checkpoint_end_date: "2026-09-30",
        next_date: "2026-09-15",
        window_until_iso: "2026-10-01T06:30:00.000Z",
      },
    });
  });

  it("does not include cumulative record counts in the request identity", () => {
    expect(
      resolveZivaSyncRequestQuery({
        ...continuationJobData,
        checkpoint: {
          version: 1,
          sourceAccountKey: "opaque-source-account-key",
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

  it("keeps requests with the same start and different end bounds distinct", () => {
    const shorter = resolveZivaSyncRequestQuery(initialJobData);
    const longer = resolveZivaSyncRequestQuery({
      ...initialJobData,
      untilIso: "2026-10-01T23:59:59.999Z",
    });

    if (shorter === null || longer === null) {
      throw new Error("Expected Ziva request queries");
    }
    expect(syncApiQueryKey(shorter)).not.toBe(syncApiQueryKey(longer));
  });

  it("keeps continuations for different source accounts distinct", () => {
    const firstAccount = resolveZivaSyncRequestQuery(continuationJobData);
    const secondAccount = resolveZivaSyncRequestQuery({
      ...continuationJobData,
      checkpoint: {
        version: 1,
        sourceAccountKey: "different-opaque-source-account-key",
        nextDate: "2026-09-15",
        endDate: "2026-09-30",
        recordsSynced: 14,
      },
    });

    if (firstAccount === null || secondAccount === null) {
      throw new Error("Expected Ziva continuation request queries");
    }
    expect(syncApiQueryKey(firstAccount)).not.toBe(syncApiQueryKey(secondAccount));
  });

  it("uses the persisted scheduled request anchor in a stable request identity", () => {
    const scheduled = {
      ...initialJobData,
      origin: "scheduled" as const,
      requestedAtIso: "2026-09-21T06:30:00.000Z",
      sinceDays: 1,
      sinceIso: undefined,
      untilIso: undefined,
    };

    expect(resolveZivaSyncRequestQuery(scheduled)).toMatchObject({
      filters: {
        origin: "scheduled",
        requested_at_iso: "2026-09-21T06:30:00.000Z",
        window_since_iso: "2026-09-20T00:00:00.000Z",
        window_until_iso: "2026-09-21T23:59:59.999Z",
      },
    });
    expect(resolveZivaSyncRequestQuery(scheduled)).toEqual(resolveZivaSyncRequestQuery(scheduled));
  });

  it("distinguishes scheduled anchors across a local midnight within one UTC date", () => {
    const beforeLocalMidnight = resolveZivaSyncRequestQuery({
      ...initialJobData,
      origin: "scheduled",
      requestedAtIso: "2026-09-21T06:30:00.000Z",
      sinceDays: 1,
      sinceIso: undefined,
      untilIso: undefined,
    });
    const afterLocalMidnight = resolveZivaSyncRequestQuery({
      ...initialJobData,
      origin: "scheduled",
      requestedAtIso: "2026-09-21T07:30:00.000Z",
      sinceDays: 1,
      sinceIso: undefined,
      untilIso: undefined,
    });

    if (beforeLocalMidnight === null || afterLocalMidnight === null) {
      throw new Error("Expected scheduled Ziva request queries");
    }
    expect(beforeLocalMidnight.filters.window_until_iso).toBe(
      afterLocalMidnight.filters.window_until_iso,
    );
    expect(syncApiQueryKey(beforeLocalMidnight)).not.toBe(syncApiQueryKey(afterLocalMidnight));
  });

  it("canonicalizes equivalent scheduled request timestamp spellings", () => {
    expect(
      resolveZivaSyncRequestQuery({
        ...initialJobData,
        requestedAtIso: "2026-09-21T06:30:00Z",
      }),
    ).toEqual(
      resolveZivaSyncRequestQuery({
        ...initialJobData,
        requestedAtIso: "2026-09-21T06:30:00.000Z",
      }),
    );
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
