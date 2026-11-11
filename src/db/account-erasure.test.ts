import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED } from "../account-erasure/snapshot-budget.ts";
import { findAccountErasureStatus } from "./account-erasure.ts";

const token = "public-status-token";
const row = {
  id: "10000000-0000-4000-8000-000000000001",
  user_id: "20000000-0000-4000-8000-000000000001",
  status_token_hash: createHash("sha256").update(token).digest("hex"),
  status: "failed",
  current_phase: null,
  requested_at: "2026-08-01T00:00:00.000Z",
  replay_retained_until: "2026-08-08T00:00:00.000Z",
  completion_deadline: "2026-08-31T00:00:00.000Z",
  completed_at: null,
  retry_at: "2026-08-02T00:00:00.000Z",
  last_error: ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED,
};

describe("findAccountErasureStatus", () => {
  it.each([
    {
      now: "2026-08-02T00:00:00.000Z",
      message: "Account deletion needs support assistance. Contact support with this request ID.",
    },
    {
      now: "2026-09-02T00:00:00.000Z",
      message:
        "Account deletion missed its 30-day deadline and needs support assistance. Contact support with this request ID.",
    },
  ])("preserves the support remedy at $now even with a retained retry date", async (input) => {
    const database = { execute: vi.fn().mockResolvedValue([row]) };
    const status = await findAccountErasureStatus(database, token, new Date(input.now));
    expect(status?.message).toBe(input.message);
    expect(status).not.toHaveProperty("lastError");
  });

  it("reports completed deletion despite a stale support reason", async () => {
    const database = {
      execute: vi
        .fn()
        .mockResolvedValue([
          { ...row, status: "completed", user_id: null, completed_at: "2026-09-01T00:00:00.000Z" },
        ]),
    };
    const status = await findAccountErasureStatus(database, token, new Date("2026-09-02"));
    expect(status?.message).toBe(
      "Account deletion completed after its 30-day deadline. Support was alerted to the delay.",
    );
  });

  it("keeps overdue unfinished requests distinct from completed deletion", async () => {
    const database = {
      execute: vi.fn().mockResolvedValue([{ ...row, last_error: null }]),
    };
    const status = await findAccountErasureStatus(database, token, new Date("2026-09-02"));
    expect(status?.message).toBe(
      "Account deletion missed its 30-day deadline. Deletion remains active and automatic retries are continuing; support has been alerted.",
    );
  });

  it.each([
    {
      status: "running",
      retry_at: null,
      message: null,
    },
    {
      status: "failed",
      retry_at: "2026-08-02T00:00:00.000Z",
      message: "Account deletion is still in progress. We are retrying it automatically.",
    },
    {
      status: "failed",
      retry_at: null,
      message: "Account deletion needs support assistance. Contact support with this request ID.",
    },
  ])("preserves ordinary $status status with retry date $retry_at", async (input) => {
    const database = {
      execute: vi
        .fn()
        .mockResolvedValue([
          { ...row, status: input.status, retry_at: input.retry_at, last_error: null },
        ]),
    };
    const status = await findAccountErasureStatus(database, token, new Date("2026-08-02"));
    expect(status?.message).toBe(input.message);
  });
});
