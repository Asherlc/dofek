import { randomUUID } from "node:crypto";
import {
  type AttemptScope,
  areaSchema,
  recordedClimbingAttemptSchema as climbingAttemptSchema,
  climbingLogEntrySchema,
  climbSchema,
  type GradeComponent,
  pitchSchema,
} from "@dofek/training/climbing-log";
import type { GpsCoordinates } from "@dofek/training/gps-coordinates";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase, TransactionDatabase } from "./index.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "./schema/climbing.ts";
import { normalizeSourceAttemptFacts, type SourceAttemptFacts } from "./source-attempt-facts.ts";
import { executeWithSchema } from "./typed-sql.ts";

export type { SourceAttemptFacts } from "./source-attempt-facts.ts";

const sourceAreaSchema = z.strictObject({
  externalId: areaSchema.shape.externalId,
  name: areaSchema.shape.name,
  coordinates: areaSchema.shape.coordinates.optional(),
  parentExternalId: areaSchema.shape.externalId.optional(),
});
const sourceClimbSchema = z.strictObject({
  externalId: climbSchema.shape.externalId,
  name: climbSchema.shape.name.optional(),
  kind: climbSchema.shape.kind.optional(),
  publishedGrades: climbSchema.shape.publishedGrades.readonly().optional(),
  routeProtection: climbSchema.shape.routeProtection.optional(),
  setting: climbSchema.shape.setting.optional(),
  coordinates: climbSchema.shape.coordinates.optional(),
  areas: z.array(sourceAreaSchema).readonly().optional(),
});
const sourcePitchSchema = z.strictObject({
  externalId: pitchSchema.shape.externalId,
  number: pitchSchema.shape.number.optional(),
  name: pitchSchema.shape.name.optional(),
  publishedGrades: pitchSchema.shape.publishedGrades.readonly().optional(),
});
const sourceClimbWithPitchesSchema = sourceClimbSchema.extend({
  pitches: z.array(sourcePitchSchema).readonly().optional(),
});
const sourcePitchReferenceSchema = z
  .strictObject({
    externalId: pitchSchema.shape.externalId.unwrap().optional(),
    number: pitchSchema.shape.number.unwrap().optional(),
  })
  .refine((reference) => reference.externalId !== undefined || reference.number !== undefined, {
    message: "An identified pitch requires its verified source ID or number.",
  });
const sourceQualifierSchema = z.enum([
  "free-onsight",
  "free-flash",
  "free-send",
  "fell-hung",
  "aid-onsight",
  "aid-flash",
  "dab",
]);
const sourceAttemptSchema = z
  .strictObject({
    scope: climbingAttemptSchema.shape.scope,
    pitch: sourcePitchReferenceSchema.optional(),
    sourceKey: z.string().trim().min(1).optional(),
    parentSourceKey: z.string().trim().min(1).optional(),
    qualifier: sourceQualifierSchema.optional(),
    attemptIndex: climbingAttemptSchema.shape.attemptIndex.optional(),
    sourceCompleted: climbingAttemptSchema.shape.sourceCompleted.optional(),
    sourceResult: climbingAttemptSchema.shape.sourceResult.optional(),
    ropeMethod: climbingAttemptSchema.shape.ropeMethod.optional(),
    solo: climbingAttemptSchema.shape.solo.optional(),
    protectionUsed: climbingAttemptSchema.shape.protectionUsed.optional(),
    usedPreplacedProtection: climbingAttemptSchema.shape.usedPreplacedProtection.optional(),
    usedAid: climbingAttemptSchema.shape.usedAid.optional(),
    fellOrHung: climbingAttemptSchema.shape.fellOrHung.optional(),
    dabbed: climbingAttemptSchema.shape.dabbed.optional(),
    receivedBeta: climbingAttemptSchema.shape.receivedBeta.optional(),
    hadCompletedBefore: climbingAttemptSchema.shape.hadCompletedBefore.optional(),
    priorFailedAttemptsGroundUp: climbingAttemptSchema.shape.priorFailedAttemptsGroundUp.optional(),
    notes: climbingAttemptSchema.shape.notes.optional(),
  })
  .refine(
    (attempt) =>
      attempt.scope === "pitch" ||
      (attempt.pitch === undefined && attempt.parentSourceKey === undefined),
    { message: "Whole-climb attempts cannot identify a pitch or parent." },
  );
const sourceAttemptCountSchema = z
  .strictObject({
    scope: climbingAttemptSchema.shape.scope,
    pitch: sourcePitchReferenceSchema.optional(),
    count: z
      .number()
      .int()
      .positive()
      .max(
        1000,
        "Source counts above 1,000 attempts cannot be expanded safely. Review the source logbook before syncing again.",
      ),
  })
  .refine((count) => count.scope === "pitch" || count.pitch === undefined, {
    message: "A whole-climb count cannot identify a pitch.",
  });
const sourceLogSchema = climbingLogEntrySchema
  .pick({
    externalId: true,
    activityId: true,
    climbedOn: true,
    discipline: true,
    title: true,
    notes: true,
    sourceName: true,
    board: true,
    wallAngle: true,
    reportedGrades: true,
    holdTypes: true,
    raw: true,
  })
  .partial()
  .extend({
    externalId: climbingLogEntrySchema.shape.externalId.unwrap(),
    climb: sourceClimbWithPitchesSchema.nullable().optional(),
    reportedAttemptCounts: z.array(sourceAttemptCountSchema).readonly().optional(),
    attempts: z.array(sourceAttemptSchema).readonly(),
  });
const sourceInputSchema = z.strictObject({
  userId: z.guid(),
  providerId: z.string().trim().min(1),
  entries: z.array(sourceLogSchema).readonly(),
});

export type SourceAreaDefinition = z.infer<typeof sourceAreaSchema>;
export type SourceClimbDefinition = z.infer<typeof sourceClimbWithPitchesSchema>;
export type SourcePitchDefinition = z.infer<typeof sourcePitchSchema>;
export type SourcePitchReference = z.infer<typeof sourcePitchReferenceSchema>;
export type SourceClimbingAttempt = z.infer<typeof sourceAttemptSchema>;
export type SourceAttemptCount = z.infer<typeof sourceAttemptCountSchema>;
export type SourceClimbingLogEntry = z.infer<typeof sourceLogSchema>;
export interface ClimbingLogSyncInput {
  userId: string;
  providerId: string;
  entries: readonly SourceClimbingLogEntry[];
}

type AreaRow = typeof area.$inferSelect;
type ClimbRow = typeof climb.$inferSelect;
type PitchRow = typeof pitch.$inferSelect;
type AttemptRow = typeof climbingAttempt.$inferSelect;
type Scope = { userId: string; providerId: string };
const cycleSchema = z.object({ cycle: z.boolean() });

function point(coordinates: GpsCoordinates | null) {
  return coordinates === null ? null : { x: coordinates.longitude, y: coordinates.latitude };
}

function mergeSupplied<T extends object>(known: T, supplied: Partial<T>): T {
  const merged = { ...known };
  for (const key in supplied) {
    if (!Object.hasOwn(supplied, key)) continue;
    const value = supplied[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

async function replaceClimbGrades(
  tx: TransactionDatabase,
  id: string,
  grades: readonly GradeComponent[] | undefined,
) {
  if (grades === undefined) return;
  await tx.delete(climbGrade).where(eq(climbGrade.climbId, id));
  if (grades.length)
    await tx
      .insert(climbGrade)
      .values(grades.map((grade, position) => ({ climbId: id, ...grade, position })));
}
async function replacePitchGrades(
  tx: TransactionDatabase,
  id: string,
  grades: readonly GradeComponent[] | undefined,
) {
  if (grades === undefined) return;
  await tx.delete(pitchGrade).where(eq(pitchGrade.pitchId, id));
  if (grades.length)
    await tx
      .insert(pitchGrade)
      .values(grades.map((grade, position) => ({ pitchId: id, ...grade, position })));
}
async function replaceLogGrades(
  tx: TransactionDatabase,
  id: string,
  grades: readonly GradeComponent[] | undefined,
) {
  if (grades === undefined) return;
  await tx.delete(climbingLogEntryGrade).where(eq(climbingLogEntryGrade.climbingLogEntryId, id));
  if (grades.length)
    await tx
      .insert(climbingLogEntryGrade)
      .values(grades.map((grade, position) => ({ climbingLogEntryId: id, ...grade, position })));
}

async function resolvePitch(
  tx: TransactionDatabase,
  climbId: string,
  source: SourcePitchDefinition,
): Promise<PitchRow> {
  if (source.externalId === null && source.number == null)
    throw new Error(
      "Pitch definitions need a verified source ID or number; keep unidentified tries at pitch scope without a target.",
    );
  const [byId] =
    source.externalId === null
      ? []
      : await tx
          .select()
          .from(pitch)
          .where(and(eq(pitch.climbId, climbId), eq(pitch.externalId, source.externalId)));
  const [byNumber] =
    source.number == null
      ? []
      : await tx
          .select()
          .from(pitch)
          .where(and(eq(pitch.climbId, climbId), eq(pitch.number, source.number)));
  if (byId && byNumber && byId.id !== byNumber.id)
    throw new Error("Source pitch ID and number identify different recorded pitches.");
  const known = byId ?? byNumber;
  if (known?.externalId && source.externalId && known.externalId !== source.externalId)
    throw new Error("The recorded pitch number conflicts with its verified source identity.");
  const { publishedGrades, externalId, ...facts } = source;
  const row = mergeSupplied(
    known ?? { id: randomUUID(), climbId, externalId, number: null, name: null },
    facts,
  );
  if (externalId !== null) row.externalId = externalId;
  if (known) await tx.update(pitch).set(row).where(eq(pitch.id, row.id));
  else await tx.insert(pitch).values(row);
  await replacePitchGrades(tx, row.id, publishedGrades);
  return row;
}

async function resolvePitchReference(
  tx: TransactionDatabase,
  definition: ClimbRow | undefined,
  reference: SourcePitchReference | undefined,
): Promise<PitchRow | undefined> {
  if (reference === undefined) return undefined;
  if (!definition) throw new Error("An identified pitch requires a recorded Climb.");
  return resolvePitch(tx, definition.id, {
    externalId: reference.externalId ?? null,
    number: reference.number,
  });
}

async function areaChain(tx: TransactionDatabase, id: string | null): Promise<AreaRow[]> {
  const nearestFirst: AreaRow[] = [];
  const visited = new Set<string>();
  let currentId = id;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error("Recorded area hierarchy contains a cycle.");
    visited.add(currentId);
    const [current] = await tx.select().from(area).where(eq(area.id, currentId));
    if (!current) throw new Error("Recorded area hierarchy references a missing area.");
    nearestFirst.push(current);
    currentId = current.parentAreaId;
  }
  return nearestFirst.reverse();
}

async function checkParent(tx: TransactionDatabase, id: string, parentId: string | null) {
  if (parentId === null) return;
  const [result] = await executeWithSchema(
    tx,
    cycleSchema,
    sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_area_id FROM fitness.area WHERE id = ${parentId}::uuid
      UNION
      SELECT parent.id, parent.parent_area_id FROM fitness.area AS parent
      JOIN ancestors AS child ON parent.id = child.parent_area_id
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${id}::uuid) AS cycle
  `,
  );
  if (result?.cycle) throw new Error("Source area hierarchy would create a cycle.");
}

async function resolveAreas(
  tx: TransactionDatabase,
  scope: Scope,
  sources: readonly SourceAreaDefinition[],
  prior: AreaRow[],
): Promise<string | null> {
  let previous: AreaRow | undefined;
  for (const [position, source] of sources.entries()) {
    const [verified] =
      source.externalId === null
        ? []
        : await tx
            .select()
            .from(area)
            .where(
              and(
                eq(area.userId, scope.userId),
                eq(area.providerId, scope.providerId),
                eq(area.externalId, source.externalId),
              ),
            );
    const associated = prior[position];
    const local =
      associated &&
      associated.name === source.name &&
      (associated.externalId === null || source.externalId === null)
        ? associated
        : undefined;
    const known = verified ?? local;
    let parentId = known?.parentAreaId ?? null;
    if (previous) {
      if (source.parentExternalId !== undefined && source.parentExternalId !== previous.externalId)
        throw new Error("Source area parent conflicts with its recorded hierarchy.");
      parentId = previous.id;
    } else if (source.parentExternalId !== undefined) {
      if (source.parentExternalId === null) parentId = null;
      else {
        const [parent] = await tx
          .select()
          .from(area)
          .where(
            and(
              eq(area.userId, scope.userId),
              eq(area.providerId, scope.providerId),
              eq(area.externalId, source.parentExternalId),
            ),
          );
        if (!parent) throw new Error("Referenced source parent needs an area definition.");
        parentId = parent.id;
      }
    }
    const id = known?.id ?? randomUUID();
    await checkParent(tx, id, parentId);
    const row: AreaRow = {
      id,
      ...scope,
      externalId: source.externalId ?? known?.externalId ?? null,
      name: source.name,
      parentAreaId: parentId,
      coordinates:
        source.coordinates === undefined ? (known?.coordinates ?? null) : point(source.coordinates),
    };
    if (known) await tx.update(area).set(row).where(eq(area.id, id));
    else await tx.insert(area).values(row);
    previous = row;
  }
  return previous?.id ?? null;
}

async function resolveClimb(
  tx: TransactionDatabase,
  scope: Scope,
  source: SourceClimbDefinition,
  associated: ClimbRow | undefined,
  oldAreas: Set<string>,
): Promise<ClimbRow> {
  const [verified] =
    source.externalId === null
      ? []
      : await tx
          .select()
          .from(climb)
          .where(
            and(
              eq(climb.userId, scope.userId),
              eq(climb.providerId, scope.providerId),
              eq(climb.externalId, source.externalId),
            ),
          );
  const reusable =
    associated &&
    (associated.externalId === null ||
      source.externalId === null ||
      associated.externalId === source.externalId)
      ? associated
      : undefined;
  const known = verified ?? reusable;
  const base: ClimbRow = known ?? {
    id: randomUUID(),
    ...scope,
    externalId: source.externalId,
    name: null,
    kind: null,
    areaId: null,
    routeProtection: null,
    setting: null,
    coordinates: null,
  };
  const { externalId, areas, coordinates, publishedGrades, pitches, ...facts } = source;
  const row = mergeSupplied(base, facts);
  if (externalId !== null) row.externalId = externalId;
  if (coordinates !== undefined) row.coordinates = point(coordinates);
  if (areas !== undefined) {
    const prior = await areaChain(tx, base.areaId);
    for (const node of prior) oldAreas.add(node.id);
    row.areaId = await resolveAreas(tx, scope, areas, prior);
  }
  climbSchema.omit({ publishedGrades: true }).parse({
    ...row,
    coordinates:
      row.coordinates === null
        ? null
        : {
            longitude: row.coordinates.x,
            latitude: row.coordinates.y,
          },
  });
  if (known) await tx.update(climb).set(row).where(eq(climb.id, row.id));
  else await tx.insert(climb).values(row);
  await replaceClimbGrades(tx, row.id, publishedGrades);
  if (pitches !== undefined)
    for (const sourcePitch of pitches) await resolvePitch(tx, row.id, sourcePitch);
  return row;
}

const factKeys = [
  "attemptIndex",
  "sourceCompleted",
  "sourceResult",
  "ropeMethod",
  "solo",
  "protectionUsed",
  "usedPreplacedProtection",
  "usedAid",
  "fellOrHung",
  "dabbed",
  "receivedBeta",
  "hadCompletedBefore",
  "priorFailedAttemptsGroundUp",
  "notes",
] as const;
type AttemptEvidence = SourceAttemptFacts & { parentAttemptId?: string | null };
type AttemptTarget = { scope: AttemptScope; pitch: PitchRow | undefined };
type PreparedAttempt = { source: SourceClimbingAttempt; target: AttemptTarget };
type PreparedCount = { source: SourceAttemptCount; target: AttemptTarget };
type PreparedLog = {
  id: string;
  climb: ClimbRow | undefined;
  source: SourceClimbingLogEntry;
  attempts: PreparedAttempt[];
  counts: PreparedCount[];
};

function equalFact(
  first: SourceAttemptFacts[keyof SourceAttemptFacts],
  second: SourceAttemptFacts[keyof SourceAttemptFacts],
) {
  if (Array.isArray(first) && Array.isArray(second))
    return (
      first.every((value) => second.includes(value)) &&
      second.every((value) => first.includes(value))
    );
  return first === second;
}
function described(attempt: AttemptEvidence): boolean {
  return factKeys.some((key) => attempt[key] != null) || attempt.parentAttemptId != null;
}
function sameFacts(first: AttemptEvidence, second: AttemptEvidence) {
  return (
    factKeys.every((key) => equalFact(first[key], second[key])) &&
    first.parentAttemptId === second.parentAttemptId
  );
}
function targetKey(target: AttemptTarget) {
  return `${target.scope}:${target.pitch?.id ?? ""}`;
}
function matchesTarget(row: AttemptRow, target: AttemptTarget) {
  return row.scope === target.scope && row.pitchId === (target.pitch?.id ?? null);
}
function suppliedFacts(source: SourceClimbingAttempt): SourceAttemptFacts {
  const {
    scope: _scope,
    pitch: _pitch,
    sourceKey: _key,
    parentSourceKey: _parent,
    qualifier: _qualifier,
    ...facts
  } = source;
  return facts;
}

function matchAttempt(
  rows: AttemptRow[],
  supplied: AttemptEvidence,
  matched: Set<string>,
  reportedCount: number | undefined,
  sharedCountedMethod: boolean,
): AttemptRow | undefined {
  const remaining = rows.filter((row) => !matched.has(row.id));
  const hasSuppliedFacts =
    factKeys.some((key) => supplied[key] !== undefined) || supplied.parentAttemptId !== undefined;
  if (!hasSuppliedFacts) return remaining[0];
  if (supplied.attemptIndex != null) {
    const indexed = remaining.filter((row) => row.attemptIndex === supplied.attemptIndex);
    if (indexed.length > 1)
      throw new Error("Actual order ambiguously matches multiple recorded attempts.");
    if (indexed[0]) return indexed[0];
  }
  const known = remaining.filter((row) => described(row));
  let compatible = known.filter(
    (row) =>
      factKeys.every(
        (key) =>
          key === "sourceResult" ||
          key === "sourceCompleted" ||
          (key === "ropeMethod" && sharedCountedMethod) ||
          supplied[key] == null ||
          row[key] == null ||
          equalFact(row[key], supplied[key]),
      ) &&
      (supplied.parentAttemptId == null ||
        row.parentAttemptId == null ||
        supplied.parentAttemptId === row.parentAttemptId),
  );
  // A method shared by counted tries does not identify an individual occurrence.
  if (
    reportedCount !== undefined &&
    compatible.length &&
    compatible.every((row) => row.ropeMethod === compatible[0]?.ropeMethod)
  ) {
    const detailed = compatible.filter((row) => described({ ...row, ropeMethod: null }));
    if (detailed.length) compatible = detailed;
  }
  if (supplied.sourceResult != null) {
    const resultMatches = compatible.filter(
      (row) =>
        row.sourceResult?.trim().toLowerCase() === supplied.sourceResult?.trim().toLowerCase(),
    );
    if (resultMatches.length === 1) return resultMatches[0];
  }
  if (supplied.sourceCompleted != null) {
    const completionMatches = compatible.filter(
      (row) => row.sourceCompleted === supplied.sourceCompleted,
    );
    if (completionMatches.length === 1) return completionMatches[0];
  }
  if (compatible.length === 1) return compatible[0];
  if (compatible.length > 1) {
    const first = compatible[0];
    if (first && compatible.every((row) => sameFacts(row, first))) return first;
    throw new Error("Source facts ambiguously match multiple recorded attempts.");
  }
  if (known.length === 1 && remaining.length === 1) return known[0];
  if (known.some((row) => supplied.attemptIndex == null || row.attemptIndex == null))
    throw new Error("Source facts ambiguously identify a described or unknown recorded attempt.");
  return remaining.find((row) => !described(row));
}

async function prepareLog(
  tx: TransactionDatabase,
  entry: { id: string; climb: ClimbRow | undefined; source: SourceClimbingLogEntry },
): Promise<PreparedLog> {
  const [currentClimb] = entry.climb
    ? await tx.select().from(climb).where(eq(climb.id, entry.climb.id))
    : [];
  let retainedPitch: PitchRow | undefined;
  const pitchSources = [
    ...entry.source.attempts,
    ...(entry.source.reportedAttemptCounts ?? []),
  ].filter((source) => source.scope === "pitch");
  if (
    currentClimb &&
    pitchSources.length &&
    pitchSources.every((source) => source.pitch === undefined)
  ) {
    const recorded = await tx
      .select({ pitchId: climbingAttempt.pitchId })
      .from(climbingAttempt)
      .where(
        and(eq(climbingAttempt.climbingLogEntryId, entry.id), eq(climbingAttempt.scope, "pitch")),
      );
    const pitchId = recorded[0]?.pitchId;
    if (pitchId && recorded.every((attempt) => attempt.pitchId === pitchId))
      [retainedPitch] = await tx
        .select()
        .from(pitch)
        .where(and(eq(pitch.id, pitchId), eq(pitch.climbId, currentClimb.id)));
  }
  const attempts: PreparedAttempt[] = [];
  const counts: PreparedCount[] = [];
  for (const source of entry.source.attempts)
    attempts.push({
      source,
      target: {
        scope: source.scope,
        pitch:
          source.pitch === undefined && source.scope === "pitch"
            ? retainedPitch
            : await resolvePitchReference(tx, currentClimb, source.pitch),
      },
    });
  for (const source of entry.source.reportedAttemptCounts ?? [])
    counts.push({
      source,
      target: {
        scope: source.scope,
        pitch:
          source.pitch === undefined && source.scope === "pitch"
            ? retainedPitch
            : await resolvePitchReference(tx, currentClimb, source.pitch),
      },
    });
  const keys = new Map<string, SourceClimbingAttempt>();
  for (const { source } of attempts)
    if (source.sourceKey !== undefined) {
      if (keys.has(source.sourceKey))
        throw new Error("Source log contains duplicate attempt correlation keys.");
      keys.set(source.sourceKey, source);
    }
  for (const { source, target } of attempts) {
    if (source.parentSourceKey !== undefined && keys.get(source.parentSourceKey)?.scope !== "climb")
      throw new Error("Pitch grouping requires a whole-climb attempt in the same source log.");
    if (target.scope === "pitch" && target.pitch === undefined && source.attemptIndex != null)
      throw new Error("An unidentified pitch cannot establish actual target order.");
  }
  return { ...entry, climb: currentClimb, attempts, counts };
}

async function otherTargetHistory(
  tx: TransactionDatabase,
  current: PreparedLog,
  target: AttemptTarget,
  batch: readonly PreparedLog[],
): Promise<boolean> {
  if (!current.climb?.externalId || (target.scope === "pitch" && target.pitch === undefined))
    return true;
  if (
    batch.some(
      (entry) =>
        entry.id !== current.id &&
        entry.climb?.id === current.climb?.id &&
        [...entry.attempts, ...entry.counts].some(
          (item) => targetKey(item.target) === targetKey(target),
        ),
    )
  )
    return true;
  const [prior] = await tx
    .select({ id: climbingAttempt.id })
    .from(climbingAttempt)
    .innerJoin(climbingLogEntry, eq(climbingLogEntry.id, climbingAttempt.climbingLogEntryId))
    .where(
      and(
        eq(climbingLogEntry.climbId, current.climb.id),
        ne(climbingLogEntry.id, current.id),
        eq(climbingAttempt.scope, target.scope),
        target.pitch ? eq(climbingAttempt.pitchId, target.pitch.id) : undefined,
      ),
    )
    .limit(1);
  return prior !== undefined;
}

function associatedParent(
  sourceKey: string | undefined,
  entry: PreparedLog,
  rows: readonly AttemptRow[],
): string | undefined {
  if (sourceKey === undefined) return undefined;
  const parents = new Set<string>();
  for (const child of entry.attempts.filter((item) => item.source.parentSourceKey === sourceKey)) {
    const facts = suppliedFacts(child.source);
    let candidates = rows.filter(
      (row) =>
        matchesTarget(row, child.target) &&
        factKeys.every(
          (key) =>
            key === "sourceResult" ||
            key === "sourceCompleted" ||
            facts[key] == null ||
            row[key] == null ||
            equalFact(facts[key], row[key]),
        ),
    );
    if (facts.sourceResult != null) {
      const resultMatches = candidates.filter(
        (row) =>
          row.sourceResult?.trim().toLowerCase() === facts.sourceResult?.trim().toLowerCase(),
      );
      if (resultMatches.length) candidates = resultMatches;
    }
    if (facts.sourceCompleted != null) {
      const completionMatches = candidates.filter(
        (row) => row.sourceCompleted === facts.sourceCompleted,
      );
      if (completionMatches.length) candidates = completionMatches;
    }
    for (const candidate of candidates)
      if (candidate.parentAttemptId) parents.add(candidate.parentAttemptId);
  }
  if (parents.size > 1)
    throw new Error("Source pitch grouping ambiguously matches multiple whole-climb attempts.");
  return parents.values().next().value;
}

async function reconcileAttempts(
  tx: TransactionDatabase,
  entry: PreparedLog,
  batch: readonly PreparedLog[],
) {
  const rows = await tx
    .select()
    .from(climbingAttempt)
    .where(eq(climbingAttempt.climbingLogEntryId, entry.id))
    .orderBy(asc(climbingAttempt.createdAt), asc(climbingAttempt.id));
  const groups = new Map<
    string,
    { target: AttemptTarget; attempts: PreparedAttempt[]; count: number | undefined }
  >();
  for (const item of [...entry.attempts, ...entry.counts])
    if (!groups.has(targetKey(item.target)))
      groups.set(targetKey(item.target), { target: item.target, attempts: [], count: undefined });
  for (const attempt of entry.attempts)
    groups.get(targetKey(attempt.target))?.attempts.push(attempt);
  for (const count of entry.counts) {
    const group = groups.get(targetKey(count.target));
    if (!group) throw new Error("Reported count has no recorded target scope.");
    if (group.count !== undefined)
      throw new Error("Source log reports overlapping counts for one target.");
    group.count = count.source.count;
  }
  const bindings = new Map<string, string>();
  for (const group of [...groups.values()].sort(
    (first, second) =>
      Number(first.target.scope === "pitch") - Number(second.target.scope === "pitch"),
  )) {
    const scopedRows = rows.filter((row) => matchesTarget(row, group.target));
    const parents = new Set(rows.map((row) => row.parentAttemptId).filter((id) => id !== null));
    // Uniform methods describe the counted group, not individual attempt identity.
    const sharedCountedMethod =
      group.count !== undefined &&
      group.attempts.length > 0 &&
      group.attempts.length === group.count &&
      group.attempts[0]?.source.ropeMethod !== undefined &&
      scopedRows.every((row) => row.ropeMethod === scopedRows[0]?.ropeMethod) &&
      group.attempts.every(
        (item) => item.source.ropeMethod === group.attempts[0]?.source.ropeMethod,
      );

    const individuallyDescribed = (row: AttemptRow) =>
      described({
        ...row,
        ropeMethod:
          sharedCountedMethod ||
          group.attempts.some((attempt) => attempt.source.ropeMethod === row.ropeMethod)
            ? null
            : row.ropeMethod,
      });
    const protectedRow = (row: AttemptRow) => individuallyDescribed(row) || parents.has(row.id);
    if (
      group.count !== undefined &&
      (group.count < group.attempts.length || group.count < scopedRows.filter(protectedRow).length)
    )
      throw new Error("Source count is below its described recorded attempts.");
    const matched = new Set<string>();
    const hasOtherTargetHistory = await otherTargetHistory(tx, entry, group.target, batch);
    for (const item of group.attempts) {
      const facts = normalizeSourceAttemptFacts(suppliedFacts(item.source), item.source.qualifier, {
        climbKind: entry.climb?.kind ?? null,
        targetIdentified:
          group.target.scope === "climb"
            ? entry.climb !== undefined
            : group.target.pitch !== undefined,
        hasOtherTargetHistory,
      });
      const parentId =
        item.source.parentSourceKey === undefined
          ? undefined
          : bindings.get(item.source.parentSourceKey);
      if (item.source.parentSourceKey !== undefined && parentId === undefined)
        throw new Error("Source parent attempt was not resolved in its log.");
      const evidence: AttemptEvidence =
        parentId === undefined ? facts : { ...facts, parentAttemptId: parentId };
      const hint = associatedParent(item.source.sourceKey, entry, rows);
      const known = hint
        ? scopedRows.find((row) => row.id === hint && !matched.has(row.id))
        : matchAttempt(scopedRows, evidence, matched, group.count, sharedCountedMethod);
      const values = {
        ...evidence,
        scope: group.target.scope,
        pitchId: group.target.pitch?.id ?? null,
      };
      let recorded: AttemptRow;
      if (known) {
        recorded = mergeSupplied(known, values);
        await tx.update(climbingAttempt).set(values).where(eq(climbingAttempt.id, known.id));
        Object.assign(known, recorded);
      } else {
        const [created] = await tx
          .insert(climbingAttempt)
          .values({ climbingLogEntryId: entry.id, ...values })
          .returning();
        if (!created) throw new Error("Recorded attempt insert returned no row.");
        recorded = created;
        rows.push(created);
        scopedRows.push(created);
      }
      matched.add(recorded.id);
      if (item.source.sourceKey !== undefined) bindings.set(item.source.sourceKey, recorded.id);
    }
    const total = group.count ?? Math.max(scopedRows.length, group.attempts.length);
    if (scopedRows.length > total) {
      const currentParents = new Set(
        rows.map((row) => row.parentAttemptId).filter((id) => id !== null),
      );
      const removable = scopedRows.filter(
        (row) => !matched.has(row.id) && !individuallyDescribed(row) && !currentParents.has(row.id),
      );
      const surplus = scopedRows.length - total;
      if (removable.length < surplus)
        throw new Error("Source count is below its described recorded attempts.");
      for (const row of removable.slice(-surplus)) {
        await tx.delete(climbingAttempt).where(eq(climbingAttempt.id, row.id));
        rows.splice(
          rows.findIndex((existing) => existing.id === row.id),
          1,
        );
      }
    } else if (scopedRows.length < total) {
      const created = await tx
        .insert(climbingAttempt)
        .values(
          Array.from({ length: total - scopedRows.length }, () => ({
            climbingLogEntryId: entry.id,
            scope: group.target.scope,
            pitchId: group.target.pitch?.id ?? null,
          })),
        )
        .returning();
      rows.push(...created);
    }
  }
}

async function removeSupersededObjects(
  tx: TransactionDatabase,
  oldClimbs: Set<string>,
  oldAreas: Set<string>,
) {
  for (const id of oldClimbs)
    await tx.execute(sql`
    DELETE FROM fitness.climb AS obsolete WHERE obsolete.id = ${id}::uuid
    AND NOT EXISTS (SELECT 1 FROM fitness.climbing_log_entry AS entry WHERE entry.climb_id = obsolete.id)
  `);
  for (const id of [...oldAreas].reverse())
    await tx.execute(sql`
    DELETE FROM fitness.area AS obsolete WHERE obsolete.id = ${id}::uuid
    AND NOT EXISTS (SELECT 1 FROM fitness.climb AS climb WHERE climb.area_id = obsolete.id)
    AND NOT EXISTS (SELECT 1 FROM fitness.area AS child WHERE child.parent_area_id = obsolete.id)
  `);
}

/** Reconcile one source batch atomically; ingestion preserves distinct source occurrences. */
export async function persistClimbingLogEntries(
  db: SyncDatabase,
  input: ClimbingLogSyncInput,
): Promise<{ logEntryIds: string[]; recordsSynced: number }> {
  const parsed = sourceInputSchema.parse(input);
  if (new Set(parsed.entries.map((entry) => entry.externalId)).size !== parsed.entries.length)
    throw new Error("Source batch contains duplicate climbing log occurrence identities.");
  return db.transaction(async (tx) => {
    const scope = { userId: parsed.userId, providerId: parsed.providerId };
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`climbing-graph:${scope.userId}:${scope.providerId}`}, 0))`,
    );
    const oldClimbs = new Set<string>();
    const oldAreas = new Set<string>();
    const resolved: Array<{
      id: string;
      climb: ClimbRow | undefined;
      source: SourceClimbingLogEntry;
    }> = [];
    for (const source of parsed.entries) {
      const [known] = await tx
        .select()
        .from(climbingLogEntry)
        .where(
          and(
            eq(climbingLogEntry.userId, scope.userId),
            eq(climbingLogEntry.providerId, scope.providerId),
            eq(climbingLogEntry.externalId, source.externalId),
          ),
        );
      const [associated] = known?.climbId
        ? await tx.select().from(climb).where(eq(climb.id, known.climbId))
        : [];
      if (associated) {
        oldClimbs.add(associated.id);
        for (const node of await areaChain(tx, associated.areaId)) oldAreas.add(node.id);
      }
      let definition = associated;
      if (source.climb === null) definition = undefined;
      else if (source.climb !== undefined)
        definition = await resolveClimb(tx, scope, source.climb, associated, oldAreas);
      const {
        climb: _climb,
        attempts: _attempts,
        reportedAttemptCounts: _counts,
        reportedGrades,
        ...facts
      } = source;
      const id = known?.id ?? randomUUID();
      const changes = { ...facts, climbId: definition?.id ?? null, providerAbsentAt: null };
      if (known) await tx.update(climbingLogEntry).set(changes).where(eq(climbingLogEntry.id, id));
      else await tx.insert(climbingLogEntry).values({ id, ...scope, ...changes });
      await replaceLogGrades(tx, id, reportedGrades);
      resolved.push({ id, climb: definition, source });
    }
    const prepared: PreparedLog[] = [];
    for (const entry of resolved) prepared.push(await prepareLog(tx, entry));
    // Every scoped occurrence is resolved before the first conditional Flash normalization.
    for (const entry of prepared) await reconcileAttempts(tx, entry, prepared);
    await removeSupersededObjects(tx, oldClimbs, oldAreas);
    return { logEntryIds: resolved.map((entry) => entry.id), recordsSynced: resolved.length };
  });
}
