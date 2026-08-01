import { describe, expect, it } from "vitest";
import { dedupeSleepMissingStates, getMissingSleepStates } from "./sleep-data-state.ts";

describe("dedupeSleepMissingStates", () => {
  it("preserves the first occurrence of each reason and next action", () => {
    const first = {
      status: "missing" as const,
      reason: "Sleep duration was not recorded.",
      nextAction: "Sync sleep data.",
    };
    const duplicate = { ...first };
    const differentAction = { ...first, nextAction: "Reconnect the sleep source." };

    expect(dedupeSleepMissingStates([first, duplicate, differentAction])).toEqual([
      first,
      differentAction,
    ]);
  });
});

describe("getMissingSleepStates", () => {
  it("collects and deduplicates missing nightly states", () => {
    const missingStages = {
      status: "missing" as const,
      reason: "Sleep stages were not reported.",
      nextAction: "Sync sleep stages.",
    };

    expect(
      getMissingSleepStates({
        durationState: { status: "available" },
        sleepState: missingStages,
        stageState: { ...missingStages },
      }),
    ).toEqual([missingStages]);
  });
});
