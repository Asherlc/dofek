import { describe, expect, it } from "vitest";
import { OuraClient } from "../oura.ts";

// ============================================================
// Extended OuraClient tests covering the remaining API endpoints
// that are untested: getDailyReadiness, getDailyActivity,
// getHeartRate (pagination), getWorkouts (pagination),
// getSessions (pagination), getTags, getEnhancedTags,
// getRestModePeriods, getSleepTime, getDailyCardiovascularAge
// ============================================================

function makeCapturingFetch(): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
    urls.push(input.toString());
    return Response.json({ data: [], next_token: null });
  };
  return { fetch: mockFetch, urls };
}

describe("OuraClient — getDailyReadiness", () => {
  it("fetches daily readiness with correct URL", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getDailyReadiness("2026-03-01", "2026-03-05");

    expect(urls[0]).toContain("/v2/usercollection/daily_readiness");
    expect(urls[0]).toContain("start_date=2026-03-01");
    expect(urls[0]).toContain("end_date=2026-03-05");
    expect(result.data).toHaveLength(0);
  });

  it("includes next_token for pagination", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyReadiness("2026-03-01", "2026-03-05", "page2");

    expect(urls[0]).toContain("next_token=page2");
  });
});

describe("OuraClient — getDailyActivity", () => {
  it("fetches daily activity with correct URL", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyActivity("2026-03-01", "2026-03-05");

    expect(urls[0]).toContain("/v2/usercollection/daily_activity");
    expect(urls[0]).toContain("start_date=2026-03-01");
  });

  it("includes next_token for pagination", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyActivity("2026-03-01", "2026-03-05", "tok123");

    expect(urls[0]).toContain("next_token=tok123");
  });
});

describe("OuraClient — getWorkouts pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getWorkouts("2026-03-01", "2026-03-05", "workout-page");

    expect(urls[0]).toContain("next_token=workout-page");
  });
});

describe("OuraClient — getHeartRate pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getHeartRate("2026-03-01", "2026-03-05", "hr-page");

    expect(urls[0]).toContain("next_token=hr-page");
  });
});

describe("OuraClient — getSessions pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getSessions("2026-03-01", "2026-03-05", "session-page");

    expect(urls[0]).toContain("next_token=session-page");
  });
});

describe("OuraClient — getDailyStress pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyStress("2026-03-01", "2026-03-05", "stress-page");

    expect(urls[0]).toContain("next_token=stress-page");
  });
});

describe("OuraClient — getDailyResilience pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyResilience("2026-03-01", "2026-03-05", "res-page");

    expect(urls[0]).toContain("next_token=res-page");
  });
});

describe("OuraClient — getDailyCardiovascularAge pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyCardiovascularAge("2026-03-01", "2026-03-05", "cv-page");

    expect(urls[0]).toContain("next_token=cv-page");
  });
});

describe("OuraClient — getTags pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getTags("2026-03-01", "2026-03-05", "tag-page");

    expect(urls[0]).toContain("next_token=tag-page");
  });
});

describe("OuraClient — getEnhancedTags pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getEnhancedTags("2026-03-01", "2026-03-05", "et-page");

    expect(urls[0]).toContain("next_token=et-page");
  });
});

describe("OuraClient — getRestModePeriods pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getRestModePeriods("2026-03-01", "2026-03-05", "rm-page");

    expect(urls[0]).toContain("next_token=rm-page");
  });
});

describe("OuraClient — getSleepTime pagination", () => {
  it("includes next_token when provided", async () => {
    const { fetch: mockFetch, urls } = makeCapturingFetch();
    const client = new OuraClient("test-token", mockFetch);
    await client.getSleepTime("2026-03-01", "2026-03-05", "st-page");

    expect(urls[0]).toContain("next_token=st-page");
  });
});
