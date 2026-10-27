import { sql } from "drizzle-orm";
import type {
  ProviderDataGenerationContext,
  ProviderDataScope,
} from "../../db/provider-data-deletion.ts";
import type { Database } from "../../db/typed-sql.ts";
import type { HealthRecord } from "./records.ts";
import type { HangTenActivitySegment, HealthWorkout, WorkoutMetadata } from "./workouts.ts";

export async function resolveProviderDataGenerationsForTest(
  database: Database,
  scopes: readonly ProviderDataScope[],
): Promise<ProviderDataGenerationContext> {
  await database.execute(sql`SELECT 0 AS generation`);
  return {
    generations: scopes.map((scope) => ({ ...scope, generation: 0 })),
    operationRevision: "1000000000000000",
  };
}

export function healthRecord(
  type: string,
  value: number,
  startDate: Date,
  unit: string,
  sourceName = "Apple Watch",
): HealthRecord {
  return {
    type,
    sourceName,
    unit,
    value,
    startDateCalendarDay: startDate.toISOString().slice(0, 10),
    startDate,
    endDate: startDate,
    creationDate: startDate,
  };
}

export function hangTenActivitySegments(): HangTenActivitySegment[] {
  return [
    {
      stepID: "step-1",
      stepNumber: 1,
      kind: "work",
      holdIDs: ["edge-19"],
      holdType: "edge",
      sizeMillimeters: 19,
      durationSeconds: 7,
    },
    {
      stepID: "step-1-rest",
      stepNumber: 1,
      kind: "rest",
      holdIDs: [],
      durationSeconds: 3,
    },
  ];
}

export function hangTenWorkout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  const startDate = overrides.startDate ?? new Date("2026-08-07T14:00:00Z");
  return {
    activityType: {
      canonicalType: "hangboard",
      providerType: "Hang Ten",
      modality: null,
    },
    sourceName: "Hang Ten",
    durationSeconds: 10,
    startDate,
    endDate: overrides.endDate ?? new Date(startDate.getTime() + 10_000),
    hangTen: {
      sessionId: "22222222-2222-4222-8222-222222222222",
      planName: "Repeaters",
      activitySegments: hangTenActivitySegments(),
    },
    ...overrides,
  };
}

export function hangTenContactMetadata(version = 3): WorkoutMetadata {
  const segments = [1, 2, 3].flatMap((round) => [
    ...Array.from({ length: 6 }, (_, repeat) => [
      {
        stepID: `round-${round}-hang-${repeat + 1}`,
        kind: "work",
        durationSeconds: 7,
        target: {
          kind: "resolvedContacts",
          resolution: {
            boardID: "tension.grindstone",
            revisionID: "2026-09-contact-first",
            modelSHA256: "board-model-checksum",
            contactIDs: ["edge-25-left", "edge-25-right"],
            requirement: {
              kind: "edge",
              selection: "bilateralPair",
              depth: { range: { minimum: 25, maximum: 25 } },
            },
          },
        },
        ...(version === 3 ? { handUse: "double", side: "both" } : {}),
      },
      {
        stepID: `round-${round}-rest-${repeat + 1}`,
        kind: "rest",
        durationSeconds: 3,
      },
    ]).flat(),
    {
      stepID: `round-${round}-recovery`,
      kind: "rest",
      durationSeconds: round === 3 ? 7.341392541668029 : 180,
    },
  ]);

  return {
    "HangTen.PlanName": "Rehab",
    "HangTen.BoardID": "tension.grindstone",
    "HangTen.BoardName": "Grindstone Mk2",
    "HangTen.SessionID": "66666666-6666-4666-8666-666666666666",
    "HangTen.ActivitySegments.v2": JSON.stringify({
      version,
      segments: segments.map((segment, index) => ({ ...segment, stepNumber: index + 1 })),
    }),
  };
}
