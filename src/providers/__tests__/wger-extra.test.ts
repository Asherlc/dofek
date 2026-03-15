import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WgerProvider,
  parseWgerWeightEntry,
  parseWgerWorkoutSession,
  wgerOAuthConfig,
} from "../wger.ts";

describe("parseWgerWorkoutSession", () => {
  it("parses a session with comment", () => {
    const session = {
      id: 42,
      date: "2026-03-01",
      comment: "Leg Day",
      impression: "2",
      time_start: "09:00",
      time_end: "10:30",
    };

    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.externalId).toBe("42");
    expect(parsed.activityType).toBe("strength");
    expect(parsed.name).toBe("Leg Day");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01"));
    expect(parsed.raw.comment).toBe("Leg Day");
    expect(parsed.raw.impression).toBe("2");
    expect(parsed.raw.timeStart).toBe("09:00");
    expect(parsed.raw.timeEnd).toBe("10:30");
  });

  it("uses 'Workout' as default name when comment is empty", () => {
    const session = {
      id: 1,
      date: "2026-03-01",
      comment: "",
      impression: "1",
      time_start: null,
      time_end: null,
    };

    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.name).toBe("Workout");
    expect(parsed.raw.timeStart).toBeNull();
    expect(parsed.raw.timeEnd).toBeNull();
  });
});

describe("parseWgerWeightEntry", () => {
  it("parses a weight entry", () => {
    const entry = {
      id: 100,
      date: "2026-03-01",
      weight: "85.5",
    };

    const parsed = parseWgerWeightEntry(entry);
    expect(parsed.externalId).toBe("100");
    expect(parsed.recordedAt).toEqual(new Date("2026-03-01"));
    expect(parsed.weightKg).toBe(85.5);
  });

  it("handles integer weight", () => {
    const parsed = parseWgerWeightEntry({ id: 1, date: "2026-03-01", weight: "80" });
    expect(parsed.weightKg).toBe(80);
  });
});

describe("wgerOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("returns null when env vars missing", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(wgerOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    const config = wgerOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("wger.de");
    expect(config?.scopes).toContain("read");
  });
});

describe("WgerProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("validate checks env vars", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(new WgerProvider().validate()).toContain("WGER_CLIENT_ID");
    process.env.WGER_CLIENT_ID = "id";
    expect(new WgerProvider().validate()).toContain("WGER_CLIENT_SECRET");
    process.env.WGER_CLIENT_SECRET = "secret";
    expect(new WgerProvider().validate()).toBeNull();
  });

  it("authSetup returns config", () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    const setup = new WgerProvider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("id");
    expect(setup.apiBaseUrl).toContain("wger.de");
  });

  it("authSetup throws when env vars missing", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(() => new WgerProvider().authSetup()).toThrow();
  });

  it("sync returns error when no tokens", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const result = await new WgerProvider().sync(mockDb as never, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
