import type { FitWorkoutStructureMessage } from "./stream-decoder.ts";

export function exactLambertsWorkout(): FitWorkoutStructureMessage[] {
  const workoutStart = Date.parse("2026-11-13T12:03:00Z");
  const specs = [
    { offset: 0, duration: 360, target: 60 },
    { offset: 360, duration: 30, target: null },
    { offset: 390, duration: 360, target: 80 },
    { offset: 750, duration: 180, target: 90 },
    { offset: 930, duration: 90, target: null },
  ];
  return [
    { messageType: "workout", raw: { wkt_name: " LSCT ", sport: 2, num_valid_steps: 5 } },
    ...specs.map(
      ({ duration, target }, index): FitWorkoutStructureMessage => ({
        messageType: "workout_step",
        raw: {
          message_index: index,
          duration_type: 0,
          duration_value: duration * 1_000,
          ...(target === null
            ? { target_type: 2, intensity: 4 }
            : {
                target_type: 1,
                target_value: 0,
                custom_target_value_low: target,
                custom_target_value_high: target,
              }),
        },
      }),
    ),
    { messageType: "lap", raw: { total_elapsed_time: 180 } },
    ...specs.map(
      ({ offset, duration }, index): FitWorkoutStructureMessage => ({
        messageType: "lap",
        raw: {
          wkt_step_index: index,
          start_time: new Date(workoutStart + offset * 1_000).toISOString(),
          timestamp: new Date(workoutStart + (offset + duration) * 1_000).toISOString(),
          total_elapsed_time: duration,
          total_timer_time: duration,
        },
      }),
    ),
    { messageType: "lap", raw: { total_elapsed_time: 1200 } },
    { messageType: "zones_target", raw: { max_heart_rate: 190 } },
  ];
}
