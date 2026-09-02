import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const activityIntegrityRetirementDispositionSchema = z.enum(["accepted", "superseded"]);
export type ActivityIntegrityRetirementDisposition = z.infer<
  typeof activityIntegrityRetirementDispositionSchema
>;

export const activityIntegrityJournalPhaseSchema = z.enum([
  "postgres_committed",
  "rebuild_failed",
  "executed",
  "rollback_committed",
  "rolled_back",
  "retired",
]);

export type ActivityIntegrityJournalPhase = z.infer<typeof activityIntegrityJournalPhaseSchema>;

const journalBaseSchema = z.object({
  run_id: uuidSchema,
  user_id: uuidSchema,
  artifact_path: z.string().min(1),
  artifact_checksum: checksumSchema,
  acceptance_owner: z.string().min(1),
  acceptance_deadline: z.coerce.date(),
  phase: activityIntegrityJournalPhaseSchema,
  accepted_by: z.string().min(1).nullable(),
  retirement_disposition: activityIntegrityRetirementDispositionSchema.nullable(),
  retired_at: z.coerce.date().nullable(),
  retirement_receipt_path: z.string().min(1).nullable(),
  retirement_receipt_checksum: checksumSchema.nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

const journalRowSchema = journalBaseSchema.superRefine((journal, context) => {
  const retirementComplete =
    journal.accepted_by != null &&
    journal.retirement_disposition != null &&
    journal.retired_at != null &&
    journal.retirement_receipt_path != null &&
    journal.retirement_receipt_checksum != null;
  if ((journal.phase === "retired") !== retirementComplete) {
    context.addIssue({
      code: "custom",
      message: "retirement journal fields must be complete exactly when phase is retired",
    });
  }
});

const journalIdentitySchema = z.object({ run_id: uuidSchema });
const eligibleJournalSchema = z.object({
  run_id: uuidSchema,
  artifact_path: z.string().min(1),
  phase: activityIntegrityJournalPhaseSchema,
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
          accepted_by,
          retirement_disposition,
          retired_at,
          retirement_receipt_path,
          retirement_receipt_checksum,
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
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          ${input.createdAt},
          ${input.createdAt}
        )
        RETURNING run_id::text AS run_id`,
  );
  if (rows.length !== 1) throw new Error("activity integrity repair journal was not created");
}

export async function retireActivityIntegrityJournal(
  db: SchemaExecutionDatabase,
  input: {
    runId: string;
    artifactPath: string;
    artifactChecksum: string;
    acceptedBy: string;
    disposition: ActivityIntegrityRetirementDisposition;
    retiredAt: Date;
    receiptPath: string;
    receiptChecksum: string;
  },
): Promise<void> {
  const rows = await executeWithSchema(
    db,
    journalIdentitySchema,
    sql`UPDATE fitness.activity_integrity_repair_journal
        SET
          phase = 'retired',
          accepted_by = ${input.acceptedBy},
          retirement_disposition = ${input.disposition},
          retired_at = ${input.retiredAt},
          retirement_receipt_path = ${input.receiptPath},
          retirement_receipt_checksum = ${input.receiptChecksum},
          updated_at = ${input.retiredAt}
        WHERE run_id = ${input.runId}::uuid
          AND artifact_path = ${input.artifactPath}
          AND artifact_checksum = ${input.artifactChecksum}
          AND phase = 'executed'
        RETURNING run_id::text AS run_id`,
  );
  if (rows.length !== 1) {
    throw new Error("stale activity integrity repair journal retirement");
  }
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
          accepted_by,
          retirement_disposition,
          retired_at,
          retirement_receipt_path,
          retirement_receipt_checksum,
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
