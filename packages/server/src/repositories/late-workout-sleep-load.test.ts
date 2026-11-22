import { describe, expect, it } from "vitest";
import { scoreLateWorkoutSleepLoad } from "./late-workout-sleep-load.ts";

const profile = { maxHeartRate: 200, birthDate: "1991-03-10" };
const workoutDate = "2026-03-10";

describe("late workout sleep heart-rate load", () => {
  it.each([
    [99, 0],
    [100, 1],
    [119, 1],
    [120, 2],
    [139, 2],
    [140, 3],
    [159, 3],
    [160, 4],
    [179, 4],
    [180, 5],
    [200, 5],
  ])("weights a complete minute at %i BPM as %i points", (bpm, score) => {
    expect(
      scoreLateWorkoutSleepLoad([{ date: workoutDate, samples: [[bpm, 60]] }], profile),
    ).toMatchObject({
      score,
      category: "light",
      coveredSeconds: 60,
      maximums: [{ bpm: 200, basis: "profile" }],
      reason: null,
    });
  });

  it("scores the recorded time at each BPM", () => {
    expect(
      scoreLateWorkoutSleepLoad([{ date: workoutDate, samples: [[130, 1800]] }], profile),
    ).toMatchObject({ score: 60, category: "light", coveredSeconds: 1800 });
  });

  it.each([
    [6959, "light"],
    [6960, "moderate"],
    [12839, "moderate"],
    [12840, "high"],
    [27660, "high"],
    [27661, "maximal"],
  ])("classifies unrounded weighted seconds at %i as %s", (seconds, category) => {
    expect(
      scoreLateWorkoutSleepLoad([{ date: workoutDate, samples: [[110, seconds]] }], profile),
    ).toMatchObject({ score: seconds / 60, category });
  });

  it("adds member scores before classifying a bout", () => {
    expect(
      scoreLateWorkoutSleepLoad(
        [
          { date: workoutDate, samples: [[130, 1800]] },
          { date: workoutDate, samples: [[130, 1800]] },
        ],
        profile,
      ),
    ).toMatchObject({ score: 120, category: "moderate", coveredSeconds: 3600 });
  });

  it("withholds score if any member lacks verified coverage", () => {
    expect(
      scoreLateWorkoutSleepLoad(
        [
          { date: workoutDate, samples: [[130, 1800]] },
          { date: workoutDate, samples: null },
        ],
        profile,
      ),
    ).toMatchObject({ score: null, category: null, reason: expect.any(String) });
  });

  it("withholds score if a recorded BPM exceeds the selected maximum", () => {
    expect(
      scoreLateWorkoutSleepLoad(
        [
          {
            date: workoutDate,
            samples: [
              [130, 1799],
              [201, 1],
            ],
          },
        ],
        profile,
      ),
    ).toMatchObject({
      score: null,
      category: null,
      coveredSeconds: 1800,
      reason: expect.any(String),
    });
  });

  it("uses age on each workout date with the estimated maximum provenance", () => {
    const load = scoreLateWorkoutSleepLoad(
      [
        { date: "2026-03-09", samples: [[130, 600]] },
        { date: workoutDate, samples: [[130, 600]] },
      ],
      { maxHeartRate: null, birthDate: profile.birthDate },
    );

    expect(load).toMatchObject({
      score: 60,
      category: "light",
      maximums: [
        { date: "2026-03-09", basis: "age_estimate", age: 34 },
        { date: workoutDate, basis: "age_estimate", age: 35 },
      ],
    });
    expect(load.maximums[1]?.bpm).toBeCloseTo(183.425, 6);
  });

  it("keeps the verified coverage when maximum and birth date are both missing", () => {
    expect(
      scoreLateWorkoutSleepLoad([{ date: workoutDate, samples: [[130, 1800]] }], {
        maxHeartRate: null,
        birthDate: null,
      }),
    ).toMatchObject({
      score: null,
      category: null,
      coveredSeconds: 1800,
      reason: expect.any(String),
    });
  });
});
