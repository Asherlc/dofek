import {
  type ClimbSetting,
  climbingAttemptSchema,
  climbingLogEntrySchema,
} from "@dofek/training/climbing-log";
import type { ClimbingProjectHistory } from "@dofek/training/climbing-project-history";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import type { ActivityRow } from "../models/activity.ts";

export function climbingProjectHistoryFixture(
  overrides: Partial<ClimbingProjectHistory> = {},
): ClimbingProjectHistory {
  return {
    throughDate: "2026-11-17",
    sessionCount: 3,
    unsuccessfulSessionCount: 2,
    unknownSessionCount: 1,
    firstSend: null,
    methodFirstSend: null,
    repeatBeforeFirstSend: false,
    earlierSessionsUnknown: false,
    days: [
      { date: "2026-11-04", outcome: "unsuccessful", method: null },
      { date: "2026-11-12", outcome: "unsuccessful", method: null },
      { date: "2026-11-17", outcome: "unknown", method: null },
    ],
    ...overrides,
  };
}

export function climbingLogEntryFixture(
  overrides: Partial<ClimbingLogEntryDetail> = {},
): ClimbingLogEntryDetail {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    providerId: "openbeta",
    externalId: "source-log",
    climbId: null,
    activityId: null,
    climbedOn: null,
    discipline: null,
    title: null,
    notes: null,
    reportedGrades: [],
    board: null,
    wallAngle: null,
    holdTypes: null,
    sourceName: null,
    raw: null,
    providerAbsentAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    climb: null,
    mapLocation: null,
    photoLogEntryId: null,
    attempts: [],
    recordedClimbAttemptCount: 0,
    recordedPitchAttemptCount: 0,
    recordedClimbOutcome: null,
    freeSend: null,
    pitchResults: [],
    displayGrade: null,
    sourceLinks: [],
    ...overrides,
  };
}
export function climbingLogDatabaseFixture(detail: ClimbingLogEntryDetail) {
  return {
    log: climbingLogEntrySchema.strip().parse(detail),
    climb: detail.climb,
    areaPath: detail.areaPath ?? detail.climb?.areaPath ?? [],
    logAreaId: detail.areaPath?.at(-1)?.id ?? null,
    freeSend: detail.freeSend,
    attempts: detail.attempts.map((attempt) => climbingAttemptSchema.strip().parse(attempt)),
  };
}

export function climbingClimbFixture(
  providerId = "openbeta",
): NonNullable<ClimbingLogEntryDetail["climb"]> {
  const userId = "20000000-0000-4000-8000-000000000002";
  return {
    id: "20000000-0000-4000-8000-000000000003",
    userId,
    providerId,
    externalId: "source-climb",
    name: "Corner",
    kind: "route",
    areaId: "20000000-0000-4000-8000-000000000004",
    publishedGrades: [{ value: "5.10a", system: "yds" }],
    setting: null,
    routeProtection: null,
    coordinates: null,
    pitches: [],
    areaPath: [
      {
        id: "20000000-0000-4000-8000-000000000004",
        userId,
        providerId,
        externalId: "source-area",
        name: "Wall",
        parentAreaId: null,
        coordinates: null,
      },
    ],
  };
}
export function climbingAttemptFixture(
  climbingLogEntryId: string,
  overrides: Partial<ClimbingLogEntryDetail["attempts"][number]> = {},
): ClimbingLogEntryDetail["attempts"][number] {
  return {
    id: "20000000-0000-4000-8000-000000000005",
    climbingLogEntryId,
    scope: "climb",
    pitchId: null,
    parentAttemptId: null,
    attemptIndex: null,
    outcome: null,
    ropeMethod: null,
    solo: null,
    protectionUsed: null,
    usedPreplacedProtection: null,
    usedAid: null,
    fellOrHung: null,
    dabbed: null,
    receivedBeta: null,
    hadCompletedBefore: null,
    priorFailedAttemptsGroundUp: null,
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    rockResultLabels: [],
    ...overrides,
  };
}

export function climbingActivityFixture(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    primary_activity_id: null,
    primary_canonical_type: null,
    primary_provider_id: null,
    primary_source_name: null,
    origin_candidate_member_ids: [],
    id: "10000000-0000-4000-8000-000000000001",
    canonical_type: "climbing",
    modality: null,
    started_at: "2026-01-02T00:30:00.000Z",
    displayed_date: "2026-01-01",
    ended_at: null,
    name: "Climbing",
    notes: null,
    perceived_exertion: null,
    provider_id: "strava",
    timezone: null,
    start_utc_offset_minutes: null,
    end_utc_offset_minutes: null,
    local_time_source: "unknown",
    subsource: null,
    source_providers: ["strava"],
    origin_evidence: [],
    source_external_ids: null,
    avg_hr: null,
    max_hr: null,
    avg_power: null,
    max_power: null,
    avg_speed: null,
    max_speed: null,
    avg_cadence: null,
    total_distance: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    sample_count: null,
    fit_recovery_error: false,
    provider_absent_at: null,
    ...overrides,
  };
}

export function climbingNamedLogEntryFixture(
  providerId: string,
  id = "20000000-0000-4000-8000-000000000001",
  completed = false,
): ClimbingLogEntryDetail {
  const climb = climbingClimbFixture(providerId);
  return climbingLogEntryFixture({
    id,
    providerId,
    climb,
    climbId: climb.id,
    discipline: "rock_climbing",
    sourceName: providerId,
    attempts: [
      climbingAttemptFixture(id, {
        ropeMethod: "lead",
        ...(completed ? { outcome: "completed", usedAid: false, fellOrHung: false } : {}),
      }),
    ],
  });
}

type ConsolidationSource = readonly [
  providerId: string,
  latitude: number | null,
  recordedAreaName?: string,
];

export function climbingConsolidationCases() {
  function logs(setting: ClimbSetting | null, sources: readonly ConsolidationSource[]) {
    return sources.map(([providerId, latitude, recordedAreaName], index) => {
      const id = `20000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      const log = climbingNamedLogEntryFixture(providerId, id);
      const sourceArea = log.climb?.areaPath[0];
      if (!log.climb || !sourceArea) throw new Error("Expected a climb with a catalogue area");
      const area = {
        ...sourceArea,
        id: `20000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
        externalId: `area-${index}`,
        coordinates: latitude === null ? null : { latitude, longitude: -122.27231 },
      };
      const climbId = `20000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`;
      const recordedArea =
        recordedAreaName === undefined
          ? undefined
          : {
              ...area,
              id: `20000000-0000-4000-8000-${String(index + 40).padStart(12, "0")}`,
              externalId: `recorded-area-${index}`,
              name: recordedAreaName,
            };
      return {
        ...log,
        externalId: `log-${index}`,
        activityId: "20000000-0000-4000-8000-000000000099",
        climbId,
        climb: {
          ...log.climb,
          id: climbId,
          externalId: `climb-${index}`,
          setting,
          areaId: area.id,
          areaPath: [area],
        },
        attempts: [
          climbingAttemptFixture(id, {
            id: `20000000-0000-4000-8000-${String(index + 50).padStart(12, "0")}`,
            ropeMethod: "lead",
          }),
        ],
        areaPath: recordedArea ? [recordedArea] : undefined,
      };
    });
  }

  return [
    {
      scenario: "nearby pins with an unspecified setting",
      entries: logs(null, [
        ["kaya", 37.892],
        ["kaya-export", 37.8927],
      ]),
      count: 1,
    },
    {
      scenario: "distant pins with an unspecified setting",
      entries: logs(null, [
        ["kaya", 37.892],
        ["kaya-export", 37.9],
      ]),
      count: 2,
    },
    {
      scenario: "different recorded wall names",
      entries: logs("outdoor", [
        ["kaya", null, "North Wall"],
        ["kaya-export", null, "South Wall"],
      ]),
      count: 2,
    },
    {
      scenario: "same-name gyms without pins",
      entries: logs("indoor", [
        ["kaya", null],
        ["kaya-export", null],
      ]),
      count: 2,
    },
    {
      scenario: "one resolved gym with pins 150 metres apart",
      entries: logs("indoor", [
        ["kaya", 37.892],
        ["kaya-export", 37.89335],
      ]),
      count: 1,
    },
    {
      scenario: "ambiguous outdoor display groups",
      entries: logs("outdoor", [
        ["kaya", null],
        ["kaya", null],
        ["kaya-export", null],
      ]),
      count: 2,
    },
    {
      scenario: "a third pin near one contributor and far from the other",
      entries: logs("outdoor", [
        ["kaya", 37.892],
        ["kaya-export", 37.8927],
        ["openbeta", 37.8913],
      ]),
      count: 2,
    },
    {
      scenario: "a missing first pin followed by conflicting pins",
      entries: logs("outdoor", [
        ["kaya", null],
        ["kaya-export", 37.892],
        ["openbeta", 37.9],
      ]),
      count: 2,
    },
    {
      scenario: "a missing middle pin between nearby pins",
      entries: logs("outdoor", [
        ["kaya", 37.892],
        ["kaya-export", null],
        ["openbeta", 37.8927],
      ]),
      count: 1,
    },
  ];
}

export function climbingBoardSeshGradeFixture({
  id = "20000000-0000-4000-8000-000000000001",
  climbId = "20000000-0000-4000-8000-000000000003",
  boardseshDifficulty = 18.672,
}: {
  id?: string;
  climbId?: string;
  boardseshDifficulty?: number;
} = {}): ClimbingLogEntryDetail {
  const entry = climbingNamedLogEntryFixture("boardsesh", id);
  if (!entry.climb) throw new Error("Expected climb");
  entry.climb.id = climbId;
  entry.climb.externalId = climbId;
  entry.climbId = climbId;
  entry.climb.kind = "boulder";
  entry.climb.publishedGrades = [];
  entry.reportedGrades = [];
  entry.raw = {
    difficulty: null,
    metadata: {
      ascent: {
        boardseshDifficulty,
        boardseshConfidence: "confirmed",
        consensusDifficulty: 18,
        consensusDifficultyName: "6b/V4",
      },
      grades: [
        { difficultyId: 18, name: "6b/V4" },
        { difficultyId: 19, name: "6b+/V4" },
        { difficultyId: 20, name: "6c/V5" },
      ],
    },
  };
  return entry;
}
export function climbingGradeSortFixtures() {
  const base = climbingNamedLogEntryFixture("openbeta");
  const lower = climbingNamedLogEntryFixture("openbeta", "20000000-0000-4000-8000-000000000006");
  const higher = climbingNamedLogEntryFixture("openbeta", "20000000-0000-4000-8000-000000000007");
  const ungraded = climbingNamedLogEntryFixture("openbeta", "20000000-0000-4000-8000-000000000008");
  for (const [index, entry] of [lower, higher, ungraded].entries()) {
    if (!entry.climb) throw new Error("Expected climb");
    entry.climb.id = `20000000-0000-4000-8000-00000000001${index}`;
    entry.climb.externalId = `distinct-climb-${index}`;
    entry.climbId = entry.climb.id;
  }
  if (!lower.climb || !higher.climb || !ungraded.climb) throw new Error("Expected climbs");
  lower.climb.publishedGrades = [{ value: "5.9", system: "yds" }];
  higher.climb.publishedGrades = [{ value: "5.11a", system: "yds" }];
  ungraded.climb.publishedGrades = [];
  return {
    base,
    lower,
    higher,
    ungraded,
    sortRows: [ungraded, lower, base, higher],
    sortedRows: [higher, base, lower, ungraded],
  };
}
export function climbingBoardSeshGradeSortFixtures() {
  const easier = climbingBoardSeshGradeFixture({ boardseshDifficulty: 18 });
  const plus = climbingBoardSeshGradeFixture({
    id: "20000000-0000-4000-8000-000000000006",
    climbId: "20000000-0000-4000-8000-000000000006",
  });
  const harder = climbingBoardSeshGradeFixture({
    id: "20000000-0000-4000-8000-000000000007",
    climbId: "20000000-0000-4000-8000-000000000007",
    boardseshDifficulty: 20,
  });
  const ungraded = climbingBoardSeshGradeFixture({
    id: "20000000-0000-4000-8000-000000000009",
    climbId: "20000000-0000-4000-8000-000000000009",
  });
  ungraded.raw = null;
  const missingClimb = climbingBoardSeshGradeFixture({
    id: "20000000-0000-4000-8000-000000000010",
    climbId: "20000000-0000-4000-8000-000000000010",
  });
  missingClimb.climb = null;
  missingClimb.climbId = null;
  const other = climbingNamedLogEntryFixture("openbeta", "20000000-0000-4000-8000-000000000011");
  if (!other.climb) throw new Error("Expected climb");
  other.climb.kind = "boulder";
  other.climb.publishedGrades = [{ value: "V1", system: "v_scale" }];
  other.raw = plus.raw;
  const nonRock = climbingNamedLogEntryFixture("openbeta", "20000000-0000-4000-8000-000000000012");
  if (!nonRock.climb) throw new Error("Expected climb");
  nonRock.discipline = "ice_climbing";
  nonRock.climb.kind = "boulder";
  nonRock.climb.publishedGrades = [{ value: "V1", system: "v_scale" }];
  nonRock.raw = plus.raw;
  const historical = climbingBoardSeshGradeFixture({
    id: "20000000-0000-4000-8000-000000000008",
    climbId: "20000000-0000-4000-8000-000000000008",
  });
  historical.raw = null;
  historical.reportedGrades = [{ value: "V2", system: "v_scale" }];
  return {
    easier,
    plus,
    harder,
    ungraded,
    missingClimb,
    other,
    nonRock,
    historical,
    boardRows: [ungraded, missingClimb, other, nonRock, plus, harder, easier],
    sortedBoardRows: [harder, plus, easier, other, ungraded, missingClimb, nonRock],
  };
}
export function climbingKayaHistoryFixture() {
  const send = climbingNamedLogEntryFixture("kaya", "20000000-0000-4000-8000-000000000001", true);
  if (!send.climb) throw new Error("Expected climb");
  send.climb.externalId = "2001";
  send.externalId = "kaya:ascent:3001";
  send.activityId = "20000000-0000-4000-8000-000000000099";
  send.raw = {
    session_id: "1000",
    attempts: null,
    ascent_type: { name: " rEdPoInT " },
    date: "2026-10-01T17:15:00Z",
  };
  const failed = climbingNamedLogEntryFixture("kaya", "20000000-0000-4000-8000-000000000011");
  failed.climb = send.climb;
  failed.activityId = send.activityId;
  failed.externalId = "kaya:session:1000:attempted:1000_2001";
  failed.raw = { attempts: 1, sent: false };
  failed.attempts = [
    climbingAttemptFixture(failed.id, {
      id: "20000000-0000-4000-8000-000000000006",
      outcome: "failed",
      ropeMethod: "lead",
    }),
  ];
  return { send, failed };
}

export function climbingActivitySessionFixtures() {
  const activityId = "20000000-0000-4000-8000-000000000020";
  const otherActivityId = "20000000-0000-4000-8000-000000000021";
  const firstSessionId = "30000000-0000-4000-8000-000000000001";
  const secondSessionId = "30000000-0000-4000-8000-000000000002";
  const rows = [
    {
      activityId,
      id: firstSessionId,
      providerId: "kilter",
      memberActivityIds: ["40000000-0000-4000-8000-000000000001"],
      firstLoggedAt: "2026-11-09T18:00:00.000Z",
      lastLoggedAt: "2026-11-09T18:04:00.000Z",
    },
    {
      activityId,
      id: secondSessionId,
      providerId: "kilter",
      memberActivityIds: ["40000000-0000-4000-8000-000000000002"],
      firstLoggedAt: "2026-11-09T18:20:00.000Z",
      lastLoggedAt: "2026-11-09T18:25:00.000Z",
    },
    {
      activityId: otherActivityId,
      id: "30000000-0000-4000-8000-000000000003",
      providerId: "kilter",
      memberActivityIds: ["40000000-0000-4000-8000-000000000003"],
      firstLoggedAt: "2026-11-10T18:00:00.000Z",
      lastLoggedAt: "2026-11-10T18:01:00.000Z",
    },
  ];

  return { activityId, otherActivityId, firstSessionId, secondSessionId, rows };
}
