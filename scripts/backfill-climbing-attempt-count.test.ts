import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillClimbingAttemptCount } from "../src/db/climbing-attempt-count-backfill.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { main } from "./backfill-climbing-attempt-count.ts";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
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
    const db = { execute: vi.fn() };
    vi.mocked(createDatabaseFromEnv).mockReturnValue(db);
    vi.mocked(backfillClimbingAttemptCount).mockResolvedValue(3);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main([]);

    expect(backfillClimbingAttemptCount).toHaveBeenCalledWith(db, false);
    expect(consoleLog).toHaveBeenCalledWith(
      "[climbing-attempt-count-backfill] dry run only; add --execute to update Postgres",
    );
    expect(Sentry.close).toHaveBeenCalledWith(2_000);
  });

  it("rejects unknown options before opening a database connection", async () => {
    await expect(main(["--unexpected"])).rejects.toThrow("Unknown option: --unexpected");
    expect(createDatabaseFromEnv).not.toHaveBeenCalled();
  });
});
