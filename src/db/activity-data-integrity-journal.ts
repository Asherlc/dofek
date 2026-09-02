import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const activityIntegrityJournalPhaseSchema = z.enum([
  "postgres_committed",
  "rebuild_failed",
  "executed",
  "rollback_committed",
  "rolled_back",
  "retired",
]);

export type ActivityIntegrityJournalPhase = z.infer<typeof activityIntegrityJournalPhaseSchema>;

const journalRowSchema = z.object({
  run_id: uuidSchema,
  user_id: uuidSchema,
  artifact_path: z.string().min(1),
  artifact_checksum: checksumSchema,
  acceptance_owner: z.string().min(1),
  acceptance_deadline: z.coerce.date(),
  phase: activityIntegrityJournalPhaseSchema,
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

const journalIdentitySchema = z.object({ run_id: uuidSchema });
const eligibleJournalSchema = journalRowSchema.pick({
  run_id: true,
  artifact_path: true,
  phase: true,
});

export type ActivityIntegrityJournalRow = z.infer<typeof journalRowSchema>;

const ELIGIBLE_PHASES = [
  "postgres_committed",
  "rebuild_failed",
  "executed",
  "rollback_committed",
] as const satisfies readonly ActivityIntegrityJournalPhase[];

export async function assertNoEligibleActivityIntegrityJournal(
  db: SchemaExecutionDatabase,
): Promise<void> {
  const rows = await executeWithSchema(
    db,
    eligibleJournalSchema,
    sql`SELECT
          run_id::text AS run_id,
          artifact_path,
          phase
        FROM fitness.activity_integrity_repair_journal
        WHERE phase IN (${sql.join(
          ELIGIBLE_PHASES.map((phase) => sql`${phase}`),
          sql`, `,
        )})
        ORDER BY created_at, run_id
        LIMIT 1`,
  );
  const active = rows[0];
  if (active) {
    throw new Error(
      `rollback-eligible repair journal ${active.run_id} must be resolved first: ${active.artifact_path}`,
    );
  }
}

export async function createPostgresCommittedActivityIntegrityJournal(
  db: SchemaExecutionDatabase,
  input: {
    runId: string;
    userId: string;
    artifactPath: string;
    artifactChecksum: string;
    acceptanceOwner: string;
    acceptanceDeadline: Date;
    createdAt: Date;
  },
): Promise<void> {
  const rows = await executeWithSchema(
    db,
    journalIdentitySchema,
    sql`INSERT INTO fitness.activity_integrity_repair_journal (
          run_id,
          user_id,
          artifact_path,
          artifact_checksum,
          acceptance_owner,
          acceptance_deadline,
          phase,
          created_at,
          updated_at
        ) VALUES (
          ${input.runId}::uuid,
          ${input.userId}::uuid,
          ${input.artifactPath},
          ${input.artifactChecksum},
          ${input.acceptanceOwner},
          ${input.acceptanceDeadline},
          'postgres_committed',
          ${input.createdAt},
          ${input.createdAt}
        )
        RETURNING run_id::text AS run_id`,
  );
  if (rows.length !== 1) throw new Error("activity integrity repair journal was not created");
}

export async function readActivityIntegrityJournal(
  db: SchemaExecutionDatabase,
  runId: string,
): Promise<ActivityIntegrityJournalRow> {
  const rows = await executeWithSchema(
    db,
    journalRowSchema,
    sql`SELECT
          run_id::text AS run_id,
          user_id::text AS user_id,
          artifact_path,
          artifact_checksum,
          acceptance_owner,
          acceptance_deadline,
          phase,
          created_at,
          updated_at
        FROM fitness.activity_integrity_repair_journal
        WHERE run_id = ${runId}::uuid`,
  );
  const journal = rows[0];
  if (!journal) throw new Error(`activity integrity repair journal not found for run ${runId}`);
  return journal;
}

export async function transitionActivityIntegrityJournal(
  db: SchemaExecutionDatabase,
  input: {
    runId: string;
    artifactPath: string;
    artifactChecksum: string;
    from: readonly ActivityIntegrityJournalPhase[];
    to: ActivityIntegrityJournalPhase;
    transitionedAt: Date;
  },
): Promise<void> {
  const rows = await executeWithSchema(
    db,
    journalIdentitySchema,
    sql`UPDATE fitness.activity_integrity_repair_journal
        SET phase = ${input.to}, updated_at = ${input.transitionedAt}
        WHERE run_id = ${input.runId}::uuid
          AND artifact_path = ${input.artifactPath}
          AND artifact_checksum = ${input.artifactChecksum}
          AND phase IN (${sql.join(
            input.from.map((phase) => sql`${phase}`),
            sql`, `,
          )})
        RETURNING run_id::text AS run_id`,
  );
  if (rows.length !== 1) {
    throw new Error(`stale activity integrity repair journal transition to ${input.to}`);
  }
}
