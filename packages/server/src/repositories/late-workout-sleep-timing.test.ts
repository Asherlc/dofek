import { describe, expect, it } from "vitest";
import { buildLateWorkoutSleepTiming } from "./late-workout-sleep-timing.ts";
import type { WorkoutWindow } from "./pre-sleep-activity-repository.ts";
import { analysisLocalClock, type SleepEpisode } from "./sleep-episode-analysis.ts";

const targetDate = "2026-03-10";
const range = { startDate: targetDate, endDate: targetDate, timezone: "UTC" };

function episode(
  id: string,
  start: string,
  end: string,
  timezone = "UTC",
  provider = "polar",
): SleepEpisode {
  const onset = analysisLocalClock(start, timezone);
  const wake = analysisLocalClock(end, timezone);
  return {
    date: wake.date,
    timing: {
      selected_session_id: id,
      source_session_ids: [id],
      source_providers: [provider],
      source_provider: provider,
      source_name: null,
      started_at: start,
      ended_at: end,
      local_start_date: onset.date,
      local_start_time: onset.time,
      local_wake_date: wake.date,
      local_wake_time: wake.time,
      display_timezone: timezone,
      timezone_source: "caller",
      local_time_context: {
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        source: "unknown",
      },
      is_nap: false,
      sleep_kind_recorded: true,
      elapsed_minutes: (Date.parse(end) - Date.parse(start)) / 60_000,
    },
    duration_minutes: 410,
    efficiency_pct: null,
    staging_available: false,
    stages_minutes: { deep: null, rem: null, light: null, awake: null },
  };
}

const target = episode("target", "2026-03-10T00:10:00Z", "2026-03-10T07:00:00Z");
const reference = episode("reference", "2026-03-10T23:50:00Z", "2026-03-11T08:00:00Z");

function workout(
  start: string,
  end: string | null,
  overrides: Partial<WorkoutWindow["activities"][number]> = {},
): WorkoutWindow["activities"][number] {
  return {
    id: start,
    canonical_type: "running",
    provider_type: "run",
    started_at: `2026-03-09T${start}:00Z`,
    ended_at: end && (end.startsWith("00") ? `2026-03-10T${end}:00Z` : `2026-03-09T${end}:00Z`),
    source_providers: ["strava"],
    fit_members: [],
    ...overrides,
  };
}

function timing(
  activities: WorkoutWindow["activities"] = [],
  episodes = [target, reference],
  wake = "2026-03-09T05:00:00Z",
) {
  const windows = new Map([
    ["target", { previousWake: { sessionId: "previous", endedAt: wake }, activities }],
  ]);
  return buildLateWorkoutSleepTiming(episodes, windows, range).find(
    (night) => night.episodeId === "target",
  );
}

describe("late workout sleep timing", () => {
  it("averages across midnight using wake dates and the full permitted month", () => {
    const differentMonth = episode("earlier", "2026-02-27T20:00:00Z", "2026-02-27T23:00:00Z");
    const weekend = episode("weekend", "2026-03-07T20:00:00Z", "2026-03-07T23:00:00Z");
    const result = timing(
      [workout("22:00", "23:30")],
      [reference, weekend, target, differentMonth],
    );

    expect(result).toMatchObject({
      date: targetDate,
      status: "matched",
      habitualOnset: {
        timestamp: "2026-03-10T00:00:00.000Z",
        month: "2026-03",
        dayClass: "weekday",
        referenceNights: [
          { date: targetDate, episodeId: "target" },
          { date: "2026-03-11", episodeId: "reference" },
        ],
      },
      actualOnset: "2026-03-10T00:10:00Z",
      durationMinutes: 410,
      finishOffsetMinutes: -30,
      actualOnsetOffsetMinutes: 10,
      minutesFromFinishToSleep: 40,
    });
  });

  it("excludes dates with multiple independent eligible main episodes from the reference", () => {
    const duplicate = episode("second", "2026-03-11T11:00:00Z", "2026-03-11T17:00:00Z");
    const result = timing([], [duplicate, reference, target]);

    expect(result?.habitualOnset).toMatchObject({
      timestamp: "2026-03-10T00:10:00.000Z",
      referenceNights: [{ episodeId: "target" }],
      ambiguousReferenceDates: ["2026-03-11"],
    });
  });

  it.each([
    ["2026-03-08", "2026-03-08T07:00:00Z", "2026-03-15T06:00:00Z"],
    ["2026-11-01", "2026-11-01T05:00:00Z", "2026-11-08T07:00:00Z"],
  ])(
    "withholds a reference that resolves to a skipped or repeated time on %s",
    (date, start, later) => {
      const timezone = "America/New_York";
      const thisNight = episode("target", start, `${date}T14:00:00Z`, timezone);
      const laterNight = episode("later", later, `${later.slice(0, 10)}T14:00:00Z`, timezone);
      const [result] = buildLateWorkoutSleepTiming([thisNight, laterNight], new Map(), {
        startDate: date,
        endDate: date,
        timezone,
      });

      expect(result?.habitualOnset).toMatchObject({
        timestamp: null,
        reason: expect.any(String),
        referenceNights: [{ episodeId: "target" }, { episodeId: "later" }],
      });
      expect(result?.actualOnsetOffsetMinutes).toBeNull();
    },
  );

  it.each([
    ["13:59", -601, "outside_study_window"],
    ["14:00", -600, "matched"],
    ["02:00", 120, "matched"],
    ["02:01", 121, "outside_study_window"],
  ])("evaluates the study boundary for a finish at %s", (finish, offset, status) => {
    const late = episode("target", "2026-03-10T04:00:00Z", "2026-03-10T13:00:00Z");
    const early = episode("reference", "2026-03-08T20:00:00Z", "2026-03-09T07:00:00Z");
    const afterMidnight = finish.startsWith("02");
    const activity = workout(afterMidnight ? "23:45" : "13:30", finish, {
      ended_at: `${afterMidnight ? targetDate : "2026-03-09"}T${finish}:00Z`,
    });

    expect(timing([activity], [early, late])).toMatchObject({
      status,
      finishOffsetMinutes: offset,
      bouts: [{ finishOffsetMinutes: offset }],
    });
  });

  it.each([
    ["20:00", "matched", 1],
    ["20:01", "ambiguous_workouts", 2],
  ])("groups adjacent workouts with a start at %s", (start, status, count) => {
    const result = timing([workout(start, "21:00"), workout("18:00", "19:00")]);
    expect(result?.status).toBe(status);
    expect(result?.bouts).toHaveLength(count);
    expect(result?.bouts.at(-1)?.finishOffsetMinutes).toBe(-180);
  });

  it("keeps an independent morning bout as evidence while matching the evening bout", () => {
    const result = timing([workout("07:00", "08:00"), workout("18:00", "19:00")]);

    expect(result).toMatchObject({
      status: "matched",
      matchedBout: { workouts: [{ id: "18:00" }] },
      bouts: [{ inStudyWindow: false }, { inStudyWindow: true }],
    });
  });

  it.each(["nap", "rest", "body_status"])(
    "keeps Oura %s evidence without extending an actual workout",
    (providerType) => {
      const result = timing([
        workout("18:00", "19:00", {
          canonical_type: "other",
          provider_type: "crossfit",
          source_providers: ["oura"],
        }),
        workout("19:30", "20:00", {
          canonical_type: "other",
          provider_type: providerType,
          source_providers: ["oura"],
        }),
      ]);

      expect(result).toMatchObject({
        status: "matched",
        finishOffsetMinutes: -300,
        matchedBout: { workouts: [{ id: "18:00" }] },
        workouts: [{ status: "eligible" }, { status: "non_workout", reason: expect.any(String) }],
      });
    },
  );

  it.each([
    [workout("19:30", null), "unknown_bounds"],
    [workout("17:45", "18:30"), "overlapping_workouts"],
    [workout("23:45", "00:15"), "crosses_wake_window"],
  ])("keeps unresolved workout evidence at $started_at", (candidate, reason) => {
    const result = timing([workout("18:00", "19:00"), candidate]);

    expect(result).toMatchObject({ status: "ambiguous_workouts", matchedBout: null });
    expect(result?.workouts).toContainEqual(
      expect.objectContaining({ id: candidate.id, status: reason }),
    );
  });

  it("excludes point-only and relaxation records from whole-workout comparison", () => {
    const result = timing([
      workout("18:00", "18:00"),
      workout("20:00", "21:00", { canonical_type: "yoga" }),
      workout("22:00", "23:00", { canonical_type: "other", provider_type: "Massage Therapy" }),
    ]);

    expect(result).toMatchObject({ status: "no_eligible_workouts", matchedBout: null, bouts: [] });
  });

  it("uses a unique FIT member's own endpoints while retaining canonical bounds", () => {
    const result = timing([
      workout("04:00", "19:00", {
        fit_members: [
          {
            id: "fit",
            started_at: "2026-03-09T17:00:00Z",
            ended_at: "2026-03-09T18:00:00Z",
          },
        ],
      }),
    ]);

    expect(result).toMatchObject({
      status: "matched",
      finishOffsetMinutes: -360,
      workouts: [{ canonicalStartedAt: "2026-03-09T04:00:00Z", fitMemberId: "fit" }],
    });
  });

  it("treats an unresolved record overlapping the evening bout as ambiguous even when it finishes outside the study window", () => {
    const overlapping = workout("22:30", null, { ended_at: "2026-03-10T03:00:00Z" });
    const result = timing([workout("22:00", "23:30"), overlapping]);

    expect(result?.workouts.find(({ id }) => id === "22:30")?.status).toBe("crosses_wake_window");
    expect(result?.status).toBe("ambiguous_workouts");
  });

  it("keeps the evening match when an unresolved record finishes outside the window without overlapping it", () => {
    const earlier = workout("06:00", null, { ended_at: "2026-03-09T07:00:00Z" });
    const result = timing([earlier, workout("22:00", "23:30")], undefined, "2026-03-09T06:30:00Z");

    expect(result?.workouts.find(({ id }) => id === "06:00")?.status).toBe("crosses_wake_window");
    expect(result?.status).toBe("matched");
  });

  it("keeps an evening match when conflicting FIT bounds all finish outside the study window", () => {
    const conflicting = workout("07:00", "09:00", {
      fit_members: [
        { id: "fit-1", started_at: "2026-03-09T07:00:00Z", ended_at: "2026-03-09T08:00:00Z" },
        { id: "fit-2", started_at: "2026-03-09T08:00:00Z", ended_at: "2026-03-09T09:00:00Z" },
      ],
    });

    expect(timing([conflicting, workout("18:00", "19:00")])).toMatchObject({
      status: "matched",
      workouts: [{ status: "conflicting_member_bounds" }, { status: "eligible" }],
      matchedBout: { workouts: [{ id: "18:00" }] },
    });
  });

  it("reports elapsed time from a single workout to actual onset without a habitual reference", () => {
    const duplicate = episode("second", "2026-03-10T11:00:00Z", "2026-03-10T17:00:00Z");

    expect(timing([workout("21:00", "22:00")], [target, duplicate])).toMatchObject({
      status: "habitual_onset_unavailable",
      finishOffsetMinutes: null,
      minutesFromFinishToSleep: 130,
      actualOnsetOffsetMinutes: null,
    });
  });

  it("preserves context for unverified sleep onset without matching the workouts", () => {
    const apple = episode(
      "target",
      target.timing.started_at,
      "2026-03-10T07:00:00Z",
      "UTC",
      "apple_health",
    );
    const result = timing([workout("21:00", "22:00")], [apple, reference]);

    expect(result).toMatchObject({
      status: "onset_unavailable",
      reason: expect.any(String),
      actualOnset: null,
      durationMinutes: null,
      durationReason: expect.any(String),
      minutesFromFinishToSleep: null,
      workouts: [{ id: "21:00", status: "onset_unavailable" }],
      bouts: [],
    });
  });

  it("keeps verified sleep and the reference when the preceding wake is missing", () => {
    const [result] = buildLateWorkoutSleepTiming([target], new Map(), range);

    expect(result).toMatchObject({
      status: "previous_wake_unavailable",
      reason: expect.any(String),
      actualOnsetOffsetMinutes: 0,
      workouts: [],
    });
  });

  it("keeps Oura time asleep while withholding an onset inferred from bedtime", () => {
    const oura = episode("target", target.timing.started_at, "2026-03-10T07:00:00Z", "UTC", "oura");

    expect(timing([], [oura, reference])).toMatchObject({
      status: "onset_unavailable",
      actualOnset: null,
      durationMinutes: 410,
      durationReason: null,
      habitualOnset: { referenceNights: [{ episodeId: "reference" }] },
    });
  });
});
