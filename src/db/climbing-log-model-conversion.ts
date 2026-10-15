import { randomUUID } from "node:crypto";
import { climbingAttemptSchema, gradeComponentSchema } from "@dofek/training/climbing-log";
import { gpsCoordinatesSchema } from "@dofek/training/gps-coordinates";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import {
  type LegacyAttemptFacts,
  LegacyClimbingFactConflict,
  type LegacyClimbingRow,
  legacyClimbingDefinition,
  legacyClimbingRowSchema,
} from "./climbing-log-legacy-source.ts";
import type { Database, TransactionDatabase } from "./index.ts";
import {
  area,
  climb,
  climbGrade,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "./schema/climbing.ts";
import { executeWithSchema } from "./typed-sql.ts";

export interface ClimbingLogConversionReport {
  inspected: number;
  conflicts: Array<{
    climbingLogEntryIds: string[];
    providerId: string;
    externalId: string | null;
    field: string;
    message: string;
  }>;
}
const stateSchema = z.object({
  legacy: z.boolean(),
  prepared: z.boolean(),
  finalized: z.boolean(),
});
export async function climbingLogModelState(db: Pick<Database, "execute">) {
  const [state] = await executeWithSchema(
    db,
    stateSchema,
    sql`SELECT to_regclass('fitness.climbing_entry') IS NOT NULL AS legacy,to_regclass('fitness.climbing_log_entry') IS NOT NULL AS finalized,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='fitness' AND table_name='climbing_entry' AND column_name='model_converted') AS prepared`,
  );
  if (!state || (!state.legacy && !state.finalized))
    throw new Error(
      "The climbing schema is missing; apply the registered schema before conversion.",
    );
  return state;
}
const oldAttemptSchema = z.object({
  id: z.string(),
  climbing_entry_id: z.string(),
  legacy_outcome: z.enum(["sent", "failed"]).nullable(),
  legacy_failure_reason: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.coerce.date(),
});
type OldAttempt = z.infer<typeof oldAttemptSchema>;
type Definition = ReturnType<typeof legacyClimbingDefinition>;
type Inventory = {
  rows: LegacyClimbingRow[];
  definitions: Map<string, Definition>;
  attempts: Map<string, OldAttempt[]>;
  report: ClimbingLogConversionReport;
};
async function inventory(db: Pick<Database, "execute">, prepared: boolean): Promise<Inventory> {
  const method = prepared ? "legacy_climb_style" : "climb_style";
  const rows = await executeWithSchema(
    db,
    legacyClimbingRowSchema,
    sql`SELECT e.id,e.user_id,e.provider_id,e.external_id,e.activity_id,a.external_id AS activity_external_id,e.unattached_date,e.climb_type,e.grade,e.grade_system,e.result_style,e.${sql.raw(method)} AS legacy_climb_style,e.route_name,e.route_protection,e.location_path,e.raw,e.attempt_count,${prepared ? sql`e.model_converted` : sql`false`} AS model_converted FROM fitness.climbing_entry e LEFT JOIN fitness.activity a ON a.id=e.activity_id ORDER BY e.id`,
  );
  const report: ClimbingLogConversionReport = { inspected: rows.length, conflicts: [] };
  const definitions = new Map<string, Definition>();
  function conflict(
    row: LegacyClimbingRow,
    field: string,
    message: string,
    externalId: string | null = row.external_id,
  ) {
    report.conflicts.push({
      climbingLogEntryIds: [row.id],
      providerId: row.provider_id,
      externalId,
      field,
      message,
    });
  }
  for (const row of rows) {
    try {
      definitions.set(row.id, legacyClimbingDefinition(row, false));
    } catch (error) {
      if (error instanceof LegacyClimbingFactConflict)
        conflict(row, error.field, error.message, error.externalId);
      else if (error instanceof z.ZodError)
        conflict(
          row,
          "sourceFacts",
          "Retained source facts failed validation. Inspect the recorded payload before conversion.",
        );
      else {
        captureException(error);
        throw error;
      }
    }
  }
  for (const row of rows) {
    const first = definitions.get(row.id);
    if (!first?.climb.externalId) continue;
    const hasOther = rows.some(
      (other) =>
        other.id !== row.id &&
        other.user_id === row.user_id &&
        other.provider_id === row.provider_id &&
        definitions.get(other.id)?.climb.externalId === first.climb.externalId,
    );
    definitions.set(row.id, legacyClimbingDefinition(row, hasOther));
  }
  const shared = new Map<string, { row: LegacyClimbingRow; fields: Record<string, unknown> }>();
  const sharedClimbs = new Map<string, Definition["climb"]>();
  const sharedAreas = new Map<string, NonNullable<Definition["climb"]["areas"]>[number]>();
  const occurrences = new Map<string, LegacyClimbingRow>();
  for (const row of rows) {
    const definition = definitions.get(row.id);
    if (!definition) continue;
    if (definition.externalId !== null) {
      const key = JSON.stringify([row.user_id, row.provider_id, definition.externalId]);
      const previous = occurrences.get(key);
      if (previous)
        report.conflicts.push({
          climbingLogEntryIds: [previous.id, row.id],
          providerId: row.provider_id,
          externalId: definition.externalId,
          field: "externalId",
          message: "Multiple retained logs claim the same verified source occurrence.",
        });
      else occurrences.set(key, row);
    }
    const objects: Array<{
      kind: string;
      externalId: string | null;
      fields: Record<string, unknown>;
    }> = [];
    if (definition.climb.externalId)
      objects.push({
        kind: "climb",
        externalId: definition.climb.externalId,
        fields: {
          name: definition.climb.name,
          kind: definition.climb.kind,
          publishedGrades: definition.climb.publishedGrades,
          routeProtection: definition.climb.routeProtection,
          setting: definition.climb.setting,
          coordinates: definition.climb.coordinates,
          areas: definition.climb.areas?.map((node) => ({
            name: node.name,
            externalId: node.externalId,
          })),
          pitches: definition.climb.pitches,
        },
      });
    for (const [index, node] of (definition.climb.areas ?? []).entries())
      if (node.externalId)
        objects.push({
          kind: "area",
          externalId: node.externalId,
          fields: {
            name: node.name,
            coordinates: node.coordinates,
            parentExternalId: definition.climb.areas?.[index - 1]?.externalId ?? null,
          },
        });
    for (const object of objects) {
      const key = JSON.stringify([row.user_id, row.provider_id, object.kind, object.externalId]);
      const previous = shared.get(key);
      if (!previous) {
        shared.set(key, { row, fields: object.fields });
        continue;
      }
      for (const [field, value] of Object.entries(object.fields)) {
        if (
          value !== undefined &&
          previous.fields[field] !== undefined &&
          JSON.stringify(value) !== JSON.stringify(previous.fields[field])
        )
          report.conflicts.push({
            climbingLogEntryIds: [previous.row.id, row.id],
            providerId: row.provider_id,
            externalId: object.externalId,
            field,
            message:
              "Shared source definitions disagree. Verify current metadata before conversion; creation time cannot choose a winner.",
          });
        else if (previous.fields[field] === undefined) previous.fields[field] = value;
      }
    }
    if (definition.climb.externalId) {
      const key = JSON.stringify([row.user_id, row.provider_id, definition.climb.externalId]);
      const previous = sharedClimbs.get(key);
      sharedClimbs.set(key, {
        ...definition.climb,
        coordinates:
          previous?.coordinates === undefined ? definition.climb.coordinates : previous.coordinates,
        pitches: previous?.pitches === undefined ? definition.climb.pitches : previous.pitches,
      });
    }
    for (const node of definition.climb.areas ?? [])
      if (node.externalId) {
        const key = JSON.stringify([row.user_id, row.provider_id, node.externalId]);
        const previous = sharedAreas.get(key);
        sharedAreas.set(key, {
          ...node,
          coordinates:
            previous?.coordinates === undefined ? node.coordinates : previous.coordinates,
        });
      }
  }
  for (const row of rows) {
    const definition = definitions.get(row.id);
    if (!definition) continue;
    const combined = definition.climb.externalId
      ? sharedClimbs.get(
          JSON.stringify([row.user_id, row.provider_id, definition.climb.externalId]),
        )
      : undefined;
    const object = combined ?? definition.climb;
    definitions.set(row.id, {
      ...definition,
      climb: {
        ...object,
        areas: object.areas?.map((node) =>
          node.externalId
            ? (sharedAreas.get(JSON.stringify([row.user_id, row.provider_id, node.externalId])) ??
              node)
            : node,
        ),
      },
    });
  }
  const outcome = prepared ? "legacy_outcome" : "outcome";
  const reason = prepared ? "legacy_failure_reason" : "failure_reason";
  const old = await executeWithSchema(
    db,
    oldAttemptSchema,
    sql`SELECT id,climbing_entry_id,${sql.raw(outcome)}::text AS legacy_outcome,${sql.raw(reason)}::text AS legacy_failure_reason,notes,created_at FROM fitness.climbing_attempt WHERE ${sql.raw(outcome)} IS NOT NULL ORDER BY created_at,id`,
  );
  const attempts = new Map<string, OldAttempt[]>();
  for (const attempt of old) {
    const list = attempts.get(attempt.climbing_entry_id) ?? [];
    list.push(attempt);
    attempts.set(attempt.climbing_entry_id, list);
  }
  for (const row of rows) {
    const old = attempts.get(row.id) ?? [];
    if (old.length > (definitions.get(row.id)?.recordedCount ?? Math.max(1, old.length)))
      conflict(
        row,
        "attemptCount",
        "Legacy detailed attempts exceed the reported total; reconcile the source evidence first.",
      );
    for (const attempt of old)
      if (attempt.legacy_failure_reason !== null && attempt.legacy_failure_reason !== "fell")
        conflict(
          row,
          "attemptFacts",
          "A legacy failure reason has no canonical fact representation. Preserve its supported source meaning before removing the legacy field.",
        );
  }
  return { rows, definitions, attempts, report };
}
export async function inspectClimbingLogConversion(
  db: Database,
): Promise<ClimbingLogConversionReport> {
  const state = await climbingLogModelState(db);
  return state.finalized
    ? validateClimbingLogConversion(db)
    : (await inventory(db, state.prepared)).report;
}

async function persistTarget(
  db: TransactionDatabase,
  row: LegacyClimbingRow,
  definition: Definition,
) {
  const object = definition.climb;
  const existing = object.externalId
    ? await db
        .select({ id: climb.id })
        .from(climb)
        .where(
          and(
            eq(climb.userId, row.user_id),
            eq(climb.providerId, row.provider_id),
            eq(climb.externalId, object.externalId),
          ),
        )
    : [];
  const climbId = existing[0]?.id ?? randomUUID();
  if (existing.length) return climbId;
  let parentId: string | null = null;
  for (const node of definition.climb.areas ?? []) {
    const existing = node.externalId
      ? await db
          .select({ id: area.id })
          .from(area)
          .where(
            and(
              eq(area.userId, row.user_id),
              eq(area.providerId, row.provider_id),
              eq(area.externalId, node.externalId),
            ),
          )
      : [];
    let id = existing[0]?.id;
    if (!id) {
      id = randomUUID();
      await db.insert(area).values({
        id,
        userId: row.user_id,
        providerId: row.provider_id,
        externalId: node.externalId,
        name: node.name,
        parentAreaId: parentId,
        coordinates: node.coordinates
          ? { x: node.coordinates.longitude, y: node.coordinates.latitude }
          : null,
      });
    }
    parentId = id;
  }
  await db.insert(climb).values({
    id: climbId,
    userId: row.user_id,
    providerId: row.provider_id,
    externalId: object.externalId,
    name: object.name,
    kind: object.kind,
    areaId: parentId,
    setting: object.setting,
    routeProtection: object.routeProtection,
    coordinates: object.coordinates
      ? { x: object.coordinates.longitude, y: object.coordinates.latitude }
      : null,
  });
  if (object.publishedGrades?.length)
    await db.insert(climbGrade).values(
      object.publishedGrades.map((g, position) => ({
        climbId,
        value: g.value,
        system: g.system,
        position,
      })),
    );
  for (const sourcePitch of object.pitches ?? []) {
    const pitchId = randomUUID();
    await db.insert(pitch).values({
      id: pitchId,
      climbId,
      externalId: sourcePitch.externalId,
      number: sourcePitch.number,
      name: sourcePitch.name,
    });
    if (sourcePitch.publishedGrades?.length)
      await db.insert(pitchGrade).values(
        sourcePitch.publishedGrades.map((g, position) => ({
          pitchId,
          value: g.value,
          system: g.system,
          position,
        })),
      );
  }
  return climbId;
}
function baseFacts(attempt: OldAttempt): LegacyAttemptFacts {
  return {
    outcome: attempt.legacy_outcome === "sent" ? "completed" : "failed",
    ...(attempt.legacy_failure_reason === "fell" ? { fellOrHung: true } : {}),
    notes: attempt.notes,
  };
}
function convertedLegacyFacts(
  attempt: OldAttempt,
  definition: Definition,
  ownsSourceFacts: boolean,
): LegacyAttemptFacts {
  const facts = ownsSourceFacts
    ? { ...baseFacts(attempt), ...definition.facts, notes: attempt.notes }
    : baseFacts(attempt);
  if (ownsSourceFacts && definition.qualifier === "fell-hung") facts.outcome = null;
  return facts;
}
async function writeAttempt(
  db: TransactionDatabase,
  row: LegacyClimbingRow,
  id: string,
  facts: LegacyAttemptFacts,
  existing: boolean,
) {
  const values = sql`'climb',${facts.attemptIndex ?? null},${facts.outcome ?? null},${facts.ropeMethod ?? null},${facts.solo ?? null},${
    facts.protectionUsed == null
      ? null
      : sql`ARRAY[${sql.join(
          facts.protectionUsed.map((value) => sql`${value}::fitness.protection_style`),
          sql`, `,
        )}]`
  },${facts.usedPreplacedProtection ?? null},${facts.usedAid ?? null},${facts.fellOrHung ?? null},${facts.dabbed ?? null},${facts.receivedBeta ?? null},${facts.hadCompletedBefore ?? null},${facts.priorFailedAttemptsGroundUp ?? null},${facts.notes ?? null}`;
  if (existing)
    await db.execute(
      sql`UPDATE fitness.climbing_attempt SET (scope,attempt_index,outcome,rope_method,solo,protection_used,used_preplaced_protection,used_aid,fell_or_hung,dabbed,received_beta,had_completed_before,prior_failed_attempts_ground_up,notes)=(${values}) WHERE id=${id}::uuid AND climbing_entry_id=${row.id}::uuid`,
    );
  else
    await db.execute(
      sql`INSERT INTO fitness.climbing_attempt(id,climbing_entry_id,scope,attempt_index,outcome,rope_method,solo,protection_used,used_preplaced_protection,used_aid,fell_or_hung,dabbed,received_beta,had_completed_before,prior_failed_attempts_ground_up,notes) VALUES(${id}::uuid,${row.id}::uuid,${values})`,
    );
}
export async function convertClimbingLogBatch(
  db: Database,
  batchSize: number,
): Promise<{ converted: number; remaining: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new Error("Conversion batch size must be a positive integer.");
  const state = await climbingLogModelState(db);
  if (state.finalized) return { converted: 0, remaining: 0 };
  if (!state.prepared) throw new Error("Run prepare before converting climbing logs.");
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(728370291)`);
    const data = await inventory(transaction, true);
    if (data.report.conflicts.length)
      throw new Error(
        "Climbing conversion preflight found conflicts. Run inspect and resolve every conflict before converting.",
      );
    const pending = data.rows.filter((row) => !row.model_converted).slice(0, batchSize);
    for (const row of pending) {
      const definition = data.definitions.get(row.id);
      if (!definition) throw new Error("Missing validated conversion definition.");
      const climbId = await persistTarget(transaction, row, definition);
      if (definition.reportedGrades.length)
        await transaction.insert(climbingLogEntryGrade).values(
          definition.reportedGrades.map((g, position) => ({
            climbingLogEntryId: row.id,
            value: g.value,
            system: g.system,
            position,
          })),
        );
      const existing = data.attempts.get(row.id) ?? [];
      const sourceIndex = Math.max(
        0,
        existing.findIndex((a) => a.legacy_outcome === "sent"),
      );
      for (const [index, attempt] of existing.entries()) {
        const facts = convertedLegacyFacts(attempt, definition, index === sourceIndex);
        await writeAttempt(transaction, row, attempt.id, facts, true);
      }
      if (existing.length === 0)
        await writeAttempt(transaction, row, randomUUID(), definition.facts, false);
      const current = Math.max(1, existing.length);
      const count = definition.recordedCount ?? current;
      if (count > current)
        await transaction.execute(
          sql`INSERT INTO fitness.climbing_attempt(climbing_entry_id,scope) SELECT ${row.id}::uuid,'climb' FROM generate_series(1,${count - current})`,
        );
      await transaction.execute(
        sql`UPDATE fitness.climbing_entry SET climb_id=${climbId}::uuid,discipline='rock_climbing',notes=${definition.notes},unattached_date=${definition.climbedOn},external_id=${definition.externalId},model_converted=true WHERE id=${row.id}::uuid`,
      );
    }
    return {
      converted: pending.length,
      remaining: data.rows.filter((row) => !row.model_converted).length - pending.length,
    };
  });
}

export async function validateClimbingLogConversion(
  db: Database,
): Promise<ClimbingLogConversionReport> {
  const state = await climbingLogModelState(db);
  if (!state.prepared && !state.finalized)
    throw new Error("Run prepare before validating climbing conversion.");
  const table = state.finalized ? "climbing_log_entry" : "climbing_entry";
  const logColumn = state.finalized ? "climbing_log_entry_id" : "climbing_entry_id";
  const data = state.finalized ? null : await inventory(db, true);
  const report = data?.report ?? { inspected: 0, conflicts: [] };
  const rows = await executeWithSchema(
    db,
    z.object({
      id: z.string(),
      provider_id: z.string(),
      external_id: z.string().nullable(),
      converted: z.boolean(),
      climb_valid: z.boolean(),
      attempt_valid: z.boolean(),
      attempt_count: z.coerce.number().int(),
    }),
    sql`SELECT e.id,e.provider_id,e.external_id,${state.finalized ? sql`true` : sql`e.model_converted`} AS converted,${state.finalized ? sql`(e.climb_id IS NULL OR (c.id IS NOT NULL AND c.user_id=e.user_id AND c.provider_id=e.provider_id))` : sql`(c.id IS NOT NULL AND c.user_id=e.user_id AND c.provider_id=e.provider_id AND e.discipline='rock_climbing')`} AS climb_valid,NOT EXISTS(SELECT 1 FROM fitness.climbing_attempt a LEFT JOIN fitness.pitch p ON p.id=a.pitch_id LEFT JOIN fitness.climbing_attempt parent ON parent.id=a.parent_attempt_id WHERE a.${sql.raw(logColumn)}=e.id AND (a.scope IS NULL OR (a.scope='climb' AND (a.pitch_id IS NOT NULL OR a.parent_attempt_id IS NOT NULL)) OR (a.pitch_id IS NOT NULL AND p.climb_id IS DISTINCT FROM e.climb_id) OR (a.parent_attempt_id IS NOT NULL AND (parent.id IS NULL OR parent.${sql.raw(logColumn)} IS DISTINCT FROM a.${sql.raw(logColumn)} OR parent.scope IS DISTINCT FROM 'climb')) OR a.parent_attempt_id=a.id)) AS attempt_valid,(SELECT count(*) FROM fitness.climbing_attempt a WHERE a.${sql.raw(logColumn)}=e.id) AS attempt_count FROM fitness.${sql.raw(table)} e LEFT JOIN fitness.climb c ON c.id=e.climb_id`,
  );
  report.inspected = rows.length;
  for (const row of rows) {
    for (const [invalid, field, message] of [
      [!row.converted, "conversion", "The log is unconverted."],
      [!row.climb_valid, "climb", "Climb ownership or discipline is invalid."],
      [!row.attempt_valid, "attemptGraph", "Attempt target, scope or parent is invalid."],
      [row.attempt_count === 0, "attemptCount", "The log has no recorded occurrence."],
    ] as const)
      if (invalid)
        report.conflicts.push({
          climbingLogEntryIds: [row.id],
          providerId: row.provider_id,
          externalId: row.external_id,
          field,
          message,
        });
  }
  if (data) {
    const factSchema = z.object(climbingAttemptSchema.shape).pick({
      id: true,
      scope: true,
      attemptIndex: true,
      outcome: true,
      ropeMethod: true,
      solo: true,
      protectionUsed: true,
      usedPreplacedProtection: true,
      usedAid: true,
      fellOrHung: true,
      dabbed: true,
      receivedBeta: true,
      hadCompletedBefore: true,
      priorFailedAttemptsGroundUp: true,
      notes: true,
    });
    const snapshots = await executeWithSchema(
      db,
      z.object({
        id: z.string(),
        publishedGrades: z.array(gradeComponentSchema),
        reportedGrades: z.array(gradeComponentSchema),
        coordinates: gpsCoordinatesSchema.nullable(),
        pitches: z.array(
          z.object({
            externalId: z.string().nullable(),
            number: z.coerce.number().nullable(),
            name: z.string().nullable(),
            publishedGrades: z.array(gradeComponentSchema),
          }),
        ),
        attempts: z.array(factSchema),
      }),
      sql`
      SELECT e.id,
        CASE WHEN c.coordinates IS NULL THEN NULL ELSE jsonb_build_object('longitude',c.coordinates[0],'latitude',c.coordinates[1]) END AS coordinates,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('externalId',p.external_id,'number',p.number,'name',p.name,'publishedGrades',COALESCE((SELECT jsonb_agg(jsonb_build_object('value',g.value,'system',g.system) ORDER BY g.position) FROM fitness.pitch_grade g WHERE g.pitch_id=p.id),'[]'::jsonb)) ORDER BY p.external_id) FROM fitness.pitch p WHERE p.climb_id=e.climb_id),'[]'::jsonb) AS pitches,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('value',g.value,'system',g.system) ORDER BY g.position) FROM fitness.climb_grade g WHERE g.climb_id=e.climb_id),'[]'::jsonb) AS "publishedGrades",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('value',g.value,'system',g.system) ORDER BY g.position) FROM fitness.climbing_log_entry_grade g WHERE g.climbing_log_entry_id=e.id),'[]'::jsonb) AS "reportedGrades",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'scope',a.scope,'attemptIndex',a.attempt_index,'outcome',a.outcome,'ropeMethod',a.rope_method,'solo',a.solo,'protectionUsed',a.protection_used,'usedPreplacedProtection',a.used_preplaced_protection,'usedAid',a.used_aid,'fellOrHung',a.fell_or_hung,'dabbed',a.dabbed,'receivedBeta',a.received_beta,'hadCompletedBefore',a.had_completed_before,'priorFailedAttemptsGroundUp',a.prior_failed_attempts_ground_up,'notes',a.notes)) FROM fitness.climbing_attempt a WHERE a.climbing_entry_id=e.id),'[]'::jsonb) AS attempts
      FROM fitness.climbing_entry e LEFT JOIN fitness.climb c ON c.id=e.climb_id WHERE e.model_converted
    `,
    );
    for (const snapshot of snapshots) {
      const original = data.rows.find((row) => row.id === snapshot.id);
      const expected = data.definitions.get(snapshot.id);
      if (!original || !expected) continue;
      const conflict = (field: string, message: string) =>
        report.conflicts.push({
          climbingLogEntryIds: [original.id],
          providerId: original.provider_id,
          externalId: expected.climb.externalId,
          field,
          message,
        });
      for (const [field, actual, wanted] of [
        ["publishedGrades", snapshot.publishedGrades, expected.climb.publishedGrades ?? []],
        ["reportedGrades", snapshot.reportedGrades, expected.reportedGrades],
      ] as const)
        if (JSON.stringify(actual) !== JSON.stringify(wanted))
          conflict(field, "Owned grades differ from the validated source-role inventory.");
      if (
        expected.climb.coordinates !== undefined &&
        JSON.stringify(snapshot.coordinates) !== JSON.stringify(expected.climb.coordinates)
      )
        conflict("coordinates", "Climb coordinates differ from retained source evidence.");
      if (
        expected.climb.pitches !== undefined &&
        (snapshot.pitches.length !== expected.climb.pitches.length ||
          expected.climb.pitches.some((wanted) => {
            const actual = snapshot.pitches.find((value) => value.externalId === wanted.externalId);
            return (
              !actual ||
              (wanted.number !== undefined && actual.number !== wanted.number) ||
              (wanted.name !== undefined && actual.name !== wanted.name) ||
              (wanted.publishedGrades !== undefined &&
                JSON.stringify(actual.publishedGrades) !== JSON.stringify(wanted.publishedGrades))
            );
          }))
      )
        conflict(
          "pitches",
          "Catalogue Pitch definitions or grades differ from retained source evidence.",
        );
      const old = data.attempts.get(original.id) ?? [];
      const count = expected.recordedCount ?? Math.max(1, old.length);
      if (snapshot.attempts.filter((attempt) => attempt.scope === "climb").length !== count)
        conflict(
          "attemptCount",
          "Recorded whole-climb occurrences do not match the retained source total or detailed occurrences.",
        );
      const matches = (actual: z.infer<typeof factSchema>, facts: LegacyAttemptFacts) =>
        Object.entries(facts).every(
          ([key, value]) => JSON.stringify(Reflect.get(actual, key)) === JSON.stringify(value),
        );
      if (
        !snapshot.attempts.some(
          (attempt) => attempt.scope === "climb" && matches(attempt, expected.facts),
        )
      )
        conflict(
          "attemptFacts",
          "The source-described attempt's independently known facts were not preserved.",
        );
      const sourceIndex = Math.max(
        0,
        old.findIndex((attempt) => attempt.legacy_outcome === "sent"),
      );
      for (const [index, attempt] of old.entries()) {
        const actual = snapshot.attempts.find((value) => value.id === attempt.id);
        if (
          !actual ||
          !matches(actual, convertedLegacyFacts(attempt, expected, index === sourceIndex))
        )
          conflict(
            "attemptFacts",
            "A retained detailed attempt identifier or known fact differs from its legacy evidence.",
          );
      }
    }
  }
  const graphIssues = await executeWithSchema(
    db,
    z.object({
      provider_id: z.string(),
      external_id: z.string().nullable(),
      field: z.string(),
      message: z.string(),
    }),
    sql`
    WITH RECURSIVE ancestry(origin_id,ancestor_id) AS (
      SELECT id,parent_area_id FROM fitness.area WHERE parent_area_id IS NOT NULL
      UNION SELECT ancestry.origin_id,parent.parent_area_id FROM ancestry JOIN fitness.area parent ON parent.id=ancestry.ancestor_id WHERE parent.parent_area_id IS NOT NULL
    ), needed_areas(id) AS (
      SELECT area_id FROM fitness.climb WHERE area_id IS NOT NULL
      UNION SELECT a.parent_area_id FROM fitness.area a JOIN needed_areas n ON n.id=a.id WHERE a.parent_area_id IS NOT NULL
    )
    SELECT provider_id,external_id,'areaGraph' AS field,'Area hierarchy contains a cycle.' AS message FROM fitness.area a WHERE EXISTS(SELECT 1 FROM ancestry WHERE origin_id=a.id AND ancestor_id=a.id)
    ${state.finalized ? sql`` : sql`UNION ALL SELECT provider_id,external_id,'sourceObjects','Converted Climb is not referenced by a retained log.' FROM fitness.climb c WHERE NOT EXISTS(SELECT 1 FROM fitness.climbing_entry e WHERE e.climb_id=c.id) UNION ALL SELECT provider_id,external_id,'sourceObjects','Converted Area is not reachable from a retained Climb.' FROM fitness.area a WHERE NOT EXISTS(SELECT 1 FROM needed_areas n WHERE n.id=a.id)`}
  `,
  );
  for (const issue of graphIssues)
    report.conflicts.push({
      climbingLogEntryIds: [],
      providerId: issue.provider_id,
      externalId: issue.external_id,
      field: issue.field,
      message: issue.message,
    });
  return report;
}
