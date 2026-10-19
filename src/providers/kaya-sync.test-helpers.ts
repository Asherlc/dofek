import { vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

export const userId = "00000000-0000-4000-8000-000000000001";

const routeAttemptCountCases = [
  { count: null, additionalAttempts: [] },
  { count: 1, additionalAttempts: [] },
  {
    count: 3,
    additionalAttempts: [
      { scope: "climb", ropeMethod: "lead" },
      { scope: "climb", ropeMethod: "lead" },
    ],
  },
];

const sourceOutcomeCases = [
  {
    label: " Onsight ",
    attempt: {
      scope: "climb",
      ropeMethod: "lead",
      qualifier: "free-onsight",
      sourceResult: " Onsight ",
    },
  },
  {
    label: "Flash",
    attempt: {
      scope: "climb",
      ropeMethod: "lead",
      qualifier: "free-flash",
      sourceResult: "Flash",
    },
  },
  {
    label: "Redpoint",
    attempt: {
      scope: "climb",
      ropeMethod: "lead",
      qualifier: "free-send",
      sourceResult: "Redpoint",
    },
  },
  {
    label: "Send",
    attempt: { scope: "climb", ropeMethod: "lead", qualifier: "free-send", sourceResult: "Send" },
  },
  {
    label: "Repeat",
    attempt: {
      scope: "climb",
      ropeMethod: "lead",
      qualifier: "free-send",
      sourceResult: "Repeat",
      hadCompletedBefore: true,
    },
  },
  { label: "Unfamiliar", attempt: { scope: "climb", ropeMethod: "lead" } },
];

export const routeAttemptCases = routeAttemptCountCases.flatMap((count) =>
  sourceOutcomeCases.map((outcome) => ({ ...count, ...outcome })),
);

export function run(db: ReturnType<typeof database>, window = defaultWindow()): SyncRun {
  return new SyncRun({ db, userId, window });
}

function defaultWindow(): SyncWindow {
  return SyncWindow.fromIsoRange({
    sinceIso: "2026-08-01T00:00:00.000Z",
    untilIso: "2026-08-02T00:00:00.000Z",
  });
}

export function database(): SyncDatabase {
  return makeTransactionalTestDatabase({
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  });
}

export function session(id: string) {
  return {
    id,
    start_time: "2026-08-01T10:00:00.000Z",
    end_time: "2026-08-01T11:00:00.000Z",
    gym: { id: "gym-1", name: "Kaya Gym" },
    attempted_climbs: [],
  };
}

export function ascent(
  id: string,
  options: {
    lead: boolean;
    climbType: string;
    grade: string | null;
    ascentType?: string;
    attempts?: number | null;
  },
) {
  return {
    id,
    session_id: "session-1",
    date: "2026-08-01T10:30:00.000Z",
    attempts: options.attempts === undefined ? 2 : options.attempts,
    ascent_type: { id: "redpoint", name: options.ascentType ?? "Redpoint" },
    climb: {
      id: `climb-${id}`,
      name: "Kaya Climb",
      lead: options.lead,
      climb_type: { id: options.climbType, name: options.climbType },
      grade: options.grade
        ? { id: `grade-${id}`, name: options.grade, climb_type_group: "route" }
        : null,
      gym: climbGym(),
      destination: null,
      area: null,
      subarea: null,
      board: null,
      angle: null,
    },
  };
}

function climbGym(): { id: string; name: string } | null {
  return { id: "gym-1", name: "Kaya Gym" };
}
