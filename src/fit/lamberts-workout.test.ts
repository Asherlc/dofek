import { describe, expect, it } from "vitest";
import { matchLambertsWorkout } from "./lamberts-workout.ts";
import { exactLambertsWorkout as exactWorkout } from "./test-helpers.ts";

describe("matchLambertsWorkout", () => {
  it("recognizes the exact structured test embedded in a ride and keeps the observed zones source", () => {
    const match = matchLambertsWorkout(exactWorkout());
    expect(match?.workout).toMatchObject({ wkt_name: " LSCT " });
    expect(match?.zonesTarget).toMatchObject({ max_heart_rate: 190 });
    expect(match?.intervals.map((interval) => interval.segment)).toEqual([
      "lsct_stage_1",
      "lsct_calibration",
      "lsct_stage_2",
      "lsct_stage_3",
      "lsct_recovery",
    ]);
    expect(match?.intervals[2]).toMatchObject({
      start: new Date("2026-11-13T12:09:30Z"),
      end: new Date("2026-11-13T12:15:30Z"),
      targetMaximumHeartRatePercent: 80,
      lap: { wkt_step_index: 2 },
      step: { message_index: 2 },
    });
  });

  it("keeps the ceiling unknown when the device has no recorded maximum", () => {
    const messages = exactWorkout().filter((message) => message.messageType !== "zones_target");
    expect(matchLambertsWorkout(messages)?.zonesTarget).toBeNull();
  });

  it("rejects similar steps on a structured workout with another name", () => {
    const messages = exactWorkout().map((message) =>
      message.messageType === "workout"
        ? { ...message, raw: { ...message.raw, wkt_name: "Progressive warmup" } }
        : message,
    );
    expect(matchLambertsWorkout(messages)).toBeNull();
  });

  it.each([
    ["a noncycling workout", { sport: 1 }],
    ["an incorrect declared step count", { num_valid_steps: 4 }],
  ])("rejects %s even when all linked laps match", (_label, raw) => {
    const messages = exactWorkout().map((message) =>
      message.messageType === "workout" ? { ...message, raw: { ...message.raw, ...raw } } : message,
    );
    expect(matchLambertsWorkout(messages)).toBeNull();
  });

  it.each([
    { label: "a distance duration", index: 0, raw: { duration_type: 1 } },
    { label: "a shorter duration", index: 0, raw: { duration_value: 350_000 } },
    { label: "a power target", index: 0, raw: { target_type: 4 } },
    { label: "a predefined heart-rate zone", index: 0, raw: { target_value: 2 } },
    { label: "a heart-rate target range", index: 0, raw: { custom_target_value_high: 62 } },
    { label: "a target during calibration", index: 1, raw: { target_type: 1 } },
    { label: "active recovery", index: 4, raw: { intensity: 0 } },
  ])("rejects $label with otherwise matching execution", ({ index, raw }) => {
    const messages = exactWorkout().map((message) =>
      message.messageType === "workout_step" && message.raw.message_index === index
        ? { ...message, raw: { ...message.raw, ...raw } }
        : message,
    );
    expect(matchLambertsWorkout(messages)).toBeNull();
  });

  it("accepts a full workout name and a rest-marked calibration step", () => {
    const messages = exactWorkout().map((message) => {
      if (message.messageType === "workout") {
        return {
          ...message,
          raw: { ...message.raw, wkt_name: "Lamberts-and Lambert  Submaximal Cycle Test" },
        };
      }
      if (message.messageType === "workout_step" && message.raw.message_index === 1) {
        return { ...message, raw: { ...message.raw, intensity: 1 } };
      }
      return message;
    });
    expect(matchLambertsWorkout(messages)?.intervals).toHaveLength(5);
  });

  it("rejects ambiguous linked laps and a test with missing recorded recovery", () => {
    const messages = exactWorkout();
    const firstStage = messages.find(
      (message) => message.messageType === "lap" && message.raw.wkt_step_index === 0,
    );
    if (!firstStage) throw new Error("Fixture needs the first stage lap");
    expect(matchLambertsWorkout([...messages, firstStage])).toBeNull();
    expect(
      matchLambertsWorkout(
        messages.filter(
          (message) => message.messageType !== "lap" || message.raw.wkt_step_index !== 4,
        ),
      ),
    ).toBeNull();
  });

  it("rejects paused time in a recorded stage and heart-rate targets in absolute bpm", () => {
    const paused = exactWorkout().map((message) =>
      message.messageType === "lap" && message.raw.wkt_step_index === 2
        ? { ...message, raw: { ...message.raw, total_timer_time: 350 } }
        : message,
    );
    const absolute = exactWorkout().map((message) =>
      message.messageType === "workout_step" && message.raw.message_index === 2
        ? { ...message, raw: { ...message.raw, custom_target_value_low: 252 } }
        : message,
    );
    expect(matchLambertsWorkout(paused)).toBeNull();
    expect(matchLambertsWorkout(absolute)).toBeNull();
  });

  it("rejects a gap between two otherwise exact recorded stages", () => {
    const messages = exactWorkout().map((message) =>
      message.messageType === "lap" && message.raw.wkt_step_index === 1
        ? {
            ...message,
            raw: {
              ...message.raw,
              start_time: "2026-11-13T12:09:01.000Z",
              timestamp: "2026-11-13T12:09:31.000Z",
            },
          }
        : message,
    );
    expect(matchLambertsWorkout(messages)).toBeNull();
  });
});
