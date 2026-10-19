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
