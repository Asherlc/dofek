import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import {
  analysisLocalClock,
  analysisTimezoneSchema,
  listSleepEpisodes,
} from "./sleep-episode-analysis.ts";

function row(overrides: Record<string, unknown> = {}) {
  return {
    selected_session_id: "sleep-1",
    source_session_ids: ["raw-1"],
    source_providers: ["oura"],
    provider_id: "oura",
    source_name: "Oura Ring",
    started_at: "2026-03-10T05:00:00.000Z",
    ended_at: "2026-03-10T12:30:00.000Z",
    timezone: "America/New_York",
    start_utc_offset_minutes: -300,
    end_utc_offset_minutes: -240,
    local_time_source: "provider_timezone",
    is_nap: false,
    sleep_kind_recorded: true,
    duration_minutes: 450,
    efficiency_pct: 91,
    deep_minutes: 90,
    rem_minutes: 110,
    light_minutes: 210,
    awake_minutes: 40,
    staging_available: true,
    ...overrides,
  };
}

describe("analysisTimezoneSchema", () => {
  it("accepts IANA zones and rejects offsets/invalid zones", () => {
    expect(analysisTimezoneSchema.parse("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(() => analysisTimezoneSchema.parse("+02:00")).toThrow();
    expect(() => analysisTimezoneSchema.parse("Mars/Olympus")).toThrow();
  });
});

describe("analysisLocalClock", () => {
  it("formats in the provided IANA timezone", () => {
    expect(analysisLocalClock("2026-03-10T05:00:00.000Z", "America/New_York")).toEqual({
      date: "2026-03-10",
      time: "01:00:00",
    });
  });

  it("formats shifted instants in UTC when an offset is supplied", () => {
    expect(analysisLocalClock("2026-03-10T05:00:00.000Z", "ignored", -300)).toEqual({
      date: "2026-03-10",
      time: "00:00:00",
    });
  });
});

describe("listSleepEpisodes", () => {
  it("queries with bindings and defaults providers/includeNaps", async () => {
    const store = makeMockSensorStore([row()]);
    const episodes = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-09",
      endDate: "2026-03-11",
      profileTimezone: "UTC",
    });

    expect(store.query).toHaveBeenCalledOnce();
    const [schema, sqlText, params] = vi.mocked(store.query).mock.calls[0] ?? [];
    expect(schema).toBeDefined();
    expect(sqlText).toContain("FROM (");
    expect(sqlText).toContain("WHERE {includeNaps:Bool} OR NOT is_nap");
    expect(sqlText).toContain("SETTINGS enable_materialized_cte = 1");
    expect(params).toEqual({
      userId: "user-1",
      startDate: "2026-03-09",
      endDate: "2026-03-11",
      providers: [],
      includeNaps: false,
    });
    expect(episodes).toHaveLength(1);
  });

  it("binds access scope and analyzes in the access timezone when detected onset access is given", async () => {
    const store = makeMockSensorStore([]);
    await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-09",
      endDate: "2026-03-11",
      profileTimezone: "UTC",
      detectedOnsetAccess: {
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        timezone: "Asia/Tokyo",
      },
    });
    const [, , params] = vi.mocked(store.query).mock.calls[0] ?? [];
    expect(params).toEqual({
      userId: "user-1",
      startDate: "2026-03-09",
      endDate: "2026-03-11",
      providers: [],
      includeNaps: false,
      analysisTimezone: "Asia/Tokyo",
      accessStartDate: "2026-03-01",
      accessEndDate: "2026-03-31",
    });
  });

  it("maps episodes using the access timezone over the input timezone", async () => {
    const store = makeMockSensorStore([row({ timezone: null, local_time_source: "unknown" })]);
    const [episode] = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-10",
      endDate: "2026-03-11",
      profileTimezone: "UTC",
      alignToProfileTimezone: true,
      detectedOnsetAccess: {
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        timezone: "Asia/Tokyo",
      },
    });
    expect(episode?.timing.display_timezone).toBe("Asia/Tokyo");
    expect(episode?.timing.local_start_date).toBe("2026-03-10");
  });

  it("passes copied provider bindings and explicit nap inclusion", async () => {
    const providers = ["oura", "apple"];
    const store = makeMockSensorStore([]);
    await listSleepEpisodes(store, {
      userId: "user-2",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      profileTimezone: "UTC",
      providers,
      includeNaps: true,
    });
    const params = vi.mocked(store.query).mock.calls[0]?.[2];
    expect(params).toMatchObject({ providers: ["oura", "apple"], includeNaps: true });
    expect(params?.providers).not.toBe(providers);
  });

  it("uses caller timezone provenance and ignores source timezone/offsets", async () => {
    const store = makeMockSensorStore([
      row({
        started_at: "2026-03-10T05:00:00.000Z",
        ended_at: "2026-03-10T13:00:00.000Z",
        timezone: "America/Chicago",
        local_time_source: "provider_offset",
        start_utc_offset_minutes: -360,
        end_utc_offset_minutes: -360,
      }),
    ]);
    const [episode] = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-09",
      endDate: "2026-03-10",
      profileTimezone: "UTC",
      analysisTimezone: "America/New_York",
      alignToProfileTimezone: true,
    });
    expect(episode?.timing.timezone_source).toBe("caller");
    expect(episode?.timing.display_timezone).toBe("America/New_York");
    expect(episode?.timing.local_start_time).toBe("01:00:00");
    expect(episode?.timing.local_wake_time).toBe("09:00:00");
    expect(episode?.timing.local_time_context).toEqual({
      timezone: "America/Chicago",
      startUtcOffsetMinutes: -360,
      endUtcOffsetMinutes: -360,
      source: "provider_offset",
    });
  });

  it("uses source named timezone provenance when available", async () => {
    const store = makeMockSensorStore([
      row({
        timezone: "America/Los_Angeles",
        local_time_source: "provider_timezone",
        started_at: "2026-03-10T08:00:00.000Z",
        ended_at: "2026-03-10T15:00:00.000Z",
      }),
    ]);
    const [episode] = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-09",
      endDate: "2026-03-10",
      profileTimezone: "UTC",
    });
    expect(episode?.timing.timezone_source).toBe("source");
    expect(episode?.timing.display_timezone).toBe("America/Los_Angeles");
    expect(episode?.timing.local_start_date).toBe("2026-03-10");
    expect(episode?.timing.local_start_time).toBe("01:00:00");
    expect(episode?.date).toBe("2026-03-10");
  });

  it("uses provider/device offsets when no named source timezone is available", async () => {
    const store = makeMockSensorStore([
      row({
        selected_session_id: "provider-offset",
        timezone: null,
        local_time_source: "provider_offset",
        start_utc_offset_minutes: 330,
        end_utc_offset_minutes: 330,
        started_at: "2026-03-10T18:30:00.000Z",
        ended_at: "2026-03-11T03:30:00.000Z",
      }),
      row({
        selected_session_id: "device-offset-open",
        timezone: null,
        local_time_source: "device_offset",
        start_utc_offset_minutes: -480,
        end_utc_offset_minutes: null,
        started_at: "2026-03-10T10:00:00.000Z",
        ended_at: null,
        duration_minutes: null,
        efficiency_pct: null,
        deep_minutes: null,
        rem_minutes: null,
        light_minutes: null,
        awake_minutes: null,
        staging_available: false,
      }),
    ]);
    const episodes = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-10",
      endDate: "2026-03-11",
      profileTimezone: "UTC",
    });

    expect(episodes).toHaveLength(2);
    const byId = new Map(episodes.map((episode) => [episode.timing.selected_session_id, episode]));
    expect(byId.get("provider-offset")).toMatchObject({
      date: "2026-03-11",
      timing: {
        timezone_source: "source",
        display_timezone: null,
        local_start_date: "2026-03-11",
        local_start_time: "00:00:00",
        local_wake_date: "2026-03-11",
        local_wake_time: "09:00:00",
        elapsed_minutes: 540,
      },
    });
    expect(byId.get("device-offset-open")).toMatchObject({
      date: "2026-03-10",
      timing: {
        timezone_source: "source",
        display_timezone: null,
        local_start_date: "2026-03-10",
        local_start_time: "02:00:00",
        local_wake_date: null,
        local_wake_time: null,
        ended_at: null,
        elapsed_minutes: null,
      },
    });
  });

  it("falls back to profile timezone for unknown source, alignment, or unusable offsets", async () => {
    const store = makeMockSensorStore([
      row({
        selected_session_id: "unknown",
        timezone: "America/Chicago",
        local_time_source: "unknown",
        started_at: "2026-03-10T05:00:00.000Z",
        ended_at: "2026-03-10T12:00:00.000Z",
      }),
      row({
        selected_session_id: "aligned",
        timezone: "America/Los_Angeles",
        local_time_source: "provider_timezone",
        started_at: "2026-03-10T08:00:00.000Z",
        ended_at: "2026-03-10T15:00:00.000Z",
      }),
      row({
        selected_session_id: "missing-offset",
        timezone: null,
        local_time_source: "provider_offset",
        start_utc_offset_minutes: 330,
        end_utc_offset_minutes: null,
        started_at: "2026-03-10T18:30:00.000Z",
        ended_at: "2026-03-11T03:30:00.000Z",
      }),
    ]);
    const episodes = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-10",
      endDate: "2026-03-11",
      profileTimezone: "America/New_York",
      alignToProfileTimezone: true,
    });

    const byId = new Map(episodes.map((episode) => [episode.timing.selected_session_id, episode]));
    expect(byId.get("unknown")?.timing).toMatchObject({
      timezone_source: "profile",
      display_timezone: "America/New_York",
      local_start_time: "01:00:00",
    });
    expect(byId.get("aligned")?.timing).toMatchObject({
      timezone_source: "profile",
      display_timezone: "America/New_York",
      local_start_time: "04:00:00",
    });
    expect(byId.get("missing-offset")?.timing).toMatchObject({
      timezone_source: "profile",
      display_timezone: "America/New_York",
      local_start_date: "2026-03-10",
      local_start_time: "14:30:00",
      local_wake_date: "2026-03-10",
      local_wake_time: "23:30:00",
    });
  });

  it("filters by computed local date range, sorts stably, and handles DST boundaries", async () => {
    const store = makeMockSensorStore([
      row({
        selected_session_id: "out-of-range",
        timezone: "America/New_York",
        local_time_source: "provider_timezone",
        started_at: "2026-03-08T02:00:00.000Z",
        ended_at: "2026-03-08T03:00:00.000Z",
      }),
      row({
        selected_session_id: "dst-fall-b",
        started_at: "2026-11-01T05:30:00.000Z",
        ended_at: "2026-11-01T12:30:00.000Z",
        timezone: "America/New_York",
        local_time_source: "provider_timezone",
      }),
      row({
        selected_session_id: "dst-fall-a",
        started_at: "2026-11-01T05:30:00.000Z",
        ended_at: "2026-11-01T12:30:00.000Z",
        timezone: "America/New_York",
        local_time_source: "provider_timezone",
      }),
      row({
        selected_session_id: "dst-spring",
        started_at: "2026-03-08T04:30:00.000Z",
        ended_at: "2026-03-08T11:30:00.000Z",
        timezone: "America/New_York",
        local_time_source: "provider_timezone",
      }),
    ]);

    const episodes = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-08",
      endDate: "2026-11-01",
      profileTimezone: "UTC",
    });

    expect(episodes.map((episode) => episode.timing.selected_session_id)).toEqual([
      "dst-spring",
      "dst-fall-a",
      "dst-fall-b",
    ]);
    expect(episodes[0]).toMatchObject({
      date: "2026-03-08",
      timing: {
        local_start_date: "2026-03-07",
        local_start_time: "23:30:00",
        local_wake_date: "2026-03-08",
        local_wake_time: "07:30:00",
      },
    });
    expect(episodes[1]).toMatchObject({
      date: "2026-11-01",
      timing: {
        local_start_time: "01:30:00",
        local_wake_time: "07:30:00",
      },
    });
  });

  it("maps naps and treats non-positive elapsed duration as unavailable", async () => {
    const store = makeMockSensorStore([
      row({
        selected_session_id: "nap",
        is_nap: true,
        sleep_kind_recorded: false,
        started_at: "2026-03-10T18:00:00.000Z",
        ended_at: "2026-03-10T18:20:00.000Z",
        duration_minutes: 20,
      }),
      row({
        selected_session_id: "zero-elapsed",
        started_at: "2026-03-10T20:00:00.000Z",
        ended_at: "2026-03-10T20:00:00.000Z",
        duration_minutes: 0,
      }),
    ]);
    const episodes = await listSleepEpisodes(store, {
      userId: "user-1",
      startDate: "2026-03-10",
      endDate: "2026-03-10",
      profileTimezone: "UTC",
      includeNaps: true,
    });

    expect(vi.mocked(store.query).mock.calls[0]?.[2]).toMatchObject({ includeNaps: true });
    expect(
      episodes.find((episode) => episode.timing.selected_session_id === "nap")?.timing,
    ).toMatchObject({
      is_nap: true,
      sleep_kind_recorded: false,
      elapsed_minutes: 20,
    });
    expect(
      episodes.find((episode) => episode.timing.selected_session_id === "zero-elapsed")?.timing
        .elapsed_minutes,
    ).toBeNull();
  });
});
