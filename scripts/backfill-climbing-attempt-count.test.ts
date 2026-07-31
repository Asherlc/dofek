import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillClimbingAttemptCount } from "../src/db/climbing-attempt-count-backfill.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import { main } from "./backfill-climbing-attempt-count.ts";

vi.mock("../src/lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  close: vi.fn(async () => true),
  init: vi.fn(),
}));
vi.mock("../src/db/climbing-attempt-count-backfill.ts", () => ({
  backfillClimbingAttemptCount: vi.fn(),
}));
vi.mock("../src/db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("main", () => {
  it("defaults to a dry run and reports the eligible count", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const db = { execute: vi.fn(), $client: { end } };
    vi.mocked(createDatabaseFromEnv).mockReturnValue(db);
    vi.mocked(backfillClimbingAttemptCount).mockResolvedValue(3);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([]);

    expect(backfillClimbingAttemptCount).toHaveBeenCalledWith(db, false);
    expect(consoleLog).toHaveBeenCalledWith(
      "[climbing-attempt-count-backfill] dry run only; add --execute to update Postgres",
    );
    expect(Sentry.close).toHaveBeenCalledWith(2_000);
    expect(end).toHaveBeenCalledOnce();
  });

  it("rejects unknown options before opening a database connection", async () => {
    await expect(main(["--unexpected"])).rejects.toThrow("Unknown option: --unexpected");
    expect(createDatabaseFromEnv).not.toHaveBeenCalled();
  });

  it("reports unexpected errors, closes the database pool, and rethrows", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const db = { execute: vi.fn(), $client: { end } };
    const error = new Error("backfill failed");
    vi.mocked(createDatabaseFromEnv).mockReturnValue(db);
    vi.mocked(backfillClimbingAttemptCount).mockRejectedValue(error);

    await expect(main([])).rejects.toThrow("backfill failed");

    expect(captureException).toHaveBeenCalledWith(error);
    expect(end).toHaveBeenCalledOnce();
    expect(Sentry.close).toHaveBeenCalledWith(2_000);
  });
});
