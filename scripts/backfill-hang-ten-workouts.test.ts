import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  init: vi.fn(),
}));

vi.mock("@sentry/node", () => sentryMocks);

const databaseMocks = vi.hoisted(() => ({
  end: vi.fn().mockResolvedValue(undefined),
  execute: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/db/index.ts", () => ({
  createDatabaseFromEnv: () => ({
    $client: { end: databaseMocks.end },
    execute: databaseMocks.execute,
  }),
}));

import { main } from "./backfill-hang-ten-workouts.ts";

describe("backfill-hang-ten-workouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SENTRY_DSN", "https://public@example.ingest.sentry.io/1");
  });

  it("initializes Sentry before running the backfill", async () => {
    await main([]);

    expect(sentryMocks.init).toHaveBeenCalledWith({
      dsn: "https://public@example.ingest.sentry.io/1",
      skipOpenTelemetrySetup: true,
    });
    expect(sentryMocks.close).toHaveBeenCalledWith(2_000);
  });
});
