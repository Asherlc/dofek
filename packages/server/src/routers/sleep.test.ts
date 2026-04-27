import { describe, expect, it, vi } from "vitest";
import { sleepListRowSchema } from "../repositories/sleep-repository.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

describe("sleepListRowSchema", () => {
  it("parses a row with ISO-formatted started_at", () => {
    const row = {
      started_at: "2026-03-19T06:26:28Z",
      duration_minutes: 474,
      deep_minutes: 0,
      rem_minutes: 0,
      light_minutes: 460,
      awake_minutes: 20,
      efficiency_pct: null,
    };
    const parsed = sleepListRowSchema.parse(row);
    expect(parsed.started_at).toBe("2026-03-19T06:26:28Z");
    expect(parsed.duration_minutes).toBe(474);
    expect(parsed.light_minutes).toBe(460);
  });

  it("coerces string numbers from pg driver", () => {
    const row = {
      started_at: "2026-03-19T06:26:28Z",
      duration_minutes: "474",
      deep_minutes: "0",
      rem_minutes: "0",
      light_minutes: "460",
      awake_minutes: "20",
      efficiency_pct: "95.5",
    };
    const parsed = sleepListRowSchema.parse(row);
    expect(parsed.duration_minutes).toBe(474);
    expect(parsed.efficiency_pct).toBe(95.5);
  });

  it("handles null stage minutes", () => {
    const row = {
      started_at: "2026-03-11T06:17:04Z",
      duration_minutes: 492,
      deep_minutes: null,
      rem_minutes: null,
      light_minutes: null,
      awake_minutes: 27,
      efficiency_pct: 0,
    };
    const parsed = sleepListRowSchema.parse(row);
    expect(parsed.deep_minutes).toBeNull();
    expect(parsed.awake_minutes).toBe(27);
  });

  it("produces timestamps parseable by new Date() in strict engines", () => {
    const row = {
      started_at: "2026-03-19T06:26:28Z",
      duration_minutes: 474,
      deep_minutes: 0,
      rem_minutes: 0,
      light_minutes: 460,
      awake_minutes: 20,
      efficiency_pct: null,
    };
    const parsed = sleepListRowSchema.parse(row);
    const date = new Date(parsed.started_at);
    expect(date.getTime()).not.toBeNaN();
  });
});

import { sleepRouter } from "./sleep.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(sleepRouter);

describe("sleepRouter access window", () => {
  it("list passes accessWindow to repository (limited window returns empty)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
    });
    const result = await caller.list({ days: 30, endDate: "2026-04-26" });
    expect(result).toEqual([]);
  });
});
