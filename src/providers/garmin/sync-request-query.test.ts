import { describe, expect, it } from "vitest";
import type { SyncJobData } from "../../jobs/queues.ts";
import { resolveGarminSyncRequestQuery } from "./sync-request-query.ts";

function jobData(overrides: Partial<SyncJobData> = {}): SyncJobData {
  return {
    providerId: "garmin",
    userId: "user-1",
    sinceIso: "2026-01-01T00:00:00Z",
    untilIso: "2026-01-08T00:00:00Z",
    ...overrides,
  };
}

describe("resolveGarminSyncRequestQuery", () => {
  it("returns initial activities query when no checkpoint exists", () => {
    expect(resolveGarminSyncRequestQuery(jobData())).toEqual({
      path: "connectapi/activities",
      filters: { start: 0 },
    });
  });

  it("returns null when checkpoint phase is done", () => {
    expect(
      resolveGarminSyncRequestQuery(
        jobData({
          checkpoint: {
            runId: "run-1",
            phase: "done",
            steps: [],
            stepIndex: 0,
            presentActivityExternalIds: [],
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when stepIndex equals steps.length (past end)", () => {
    expect(
      resolveGarminSyncRequestQuery(
        jobData({
          checkpoint: {
            runId: "run-1",
            phase: "api",
            steps: [{ type: "sleep", date: "2026-01-01" }],
            stepIndex: 1,
            presentActivityExternalIds: [],
          },
        }),
      ),
    ).toBeNull();
  });

  it("maps a valid step to an API query", () => {
    expect(
      resolveGarminSyncRequestQuery(
        jobData({
          checkpoint: {
            runId: "run-1",
            phase: "api",
            steps: [{ type: "sleep", date: "2026-01-01" }],
            stepIndex: 0,
            presentActivityExternalIds: [],
          },
        }),
      ),
    ).toEqual({
      path: "connectapi/sleep",
      filters: { date: "2026-01-01" },
    });
  });
});
