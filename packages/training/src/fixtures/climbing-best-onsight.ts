import type { ClimbingBestOnsight, ClimbingBestOnsightCell } from "../climbing-best-onsight.ts";
import { climbingTypeOptions } from "../climbing-filters.ts";

const GYM_PROVIDER_ID = "kaya";
const OUTDOOR_PROVIDER_ID = "eight-a";

function recordId(sequence: number): string {
  return `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`;
}

/**
 * Representative 12-month result matching the approved climbing-page design:
 * bouldering and lead have a gym and outdoor send; the remaining types are empty.
 */
export function climbingBestOnsightFixture(): ClimbingBestOnsight {
  const cells: Record<string, { gym: ClimbingBestOnsightCell; outdoor: ClimbingBestOnsightCell }> =
    {
      bouldering: {
        gym: {
          grade: "V5",
          gradeSystem: "v_scale",
          providerId: GYM_PROVIDER_ID,
          recordId: recordId(1),
        },
        outdoor: {
          grade: "6B+",
          gradeSystem: "font",
          providerId: OUTDOOR_PROVIDER_ID,
          recordId: recordId(2),
        },
      },
      lead: {
        gym: {
          grade: "5.11a",
          gradeSystem: "yds",
          providerId: GYM_PROVIDER_ID,
          recordId: recordId(3),
        },
        outdoor: {
          grade: "5.10c",
          gradeSystem: "yds",
          providerId: OUTDOOR_PROVIDER_ID,
          recordId: recordId(4),
        },
      },
    };

  return {
    startDate: "2025-11-22",
    endDate: "2026-11-21",
    rows: climbingTypeOptions.map(([type]) => ({
      type,
      gym: cells[type]?.gym ?? null,
      outdoor: cells[type]?.outdoor ?? null,
    })),
  };
}

export function emptyClimbingBestOnsightFixture(): ClimbingBestOnsight {
  return {
    startDate: "2025-11-22",
    endDate: "2026-11-21",
    rows: climbingTypeOptions.map(([type]) => ({ type, gym: null, outdoor: null })),
  };
}
