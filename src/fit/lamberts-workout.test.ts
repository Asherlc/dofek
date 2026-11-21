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
});
