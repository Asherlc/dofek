import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, TransactionDatabase } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import {
  decryptCredentialValue,
  deriveCredentialIdentifier,
  deriveCredentialKeyringIdentifier,
  encryptCredentialValue,
} from "../security/credential-encryption.ts";

import {
  listAccountErasurePostgresIdentifierPages,
  ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE as POSTGRES_IDENTIFIER_PAGE_SIZE,
} from "./postgres-identifier-capture.ts";

import {
  type AccountErasurePhysicalIntent,
  type AccountErasurePhysicalMutation,
  type AccountErasurePhysicalPart,
  type AccountErasurePhysicalProgress,
  type AccountErasurePhysicalStage,
  cursorSchema,
  familySchema,
  identifierSchema,
  isPhysicalFamily,
  type PhysicalFamily,
  type PhysicalPage,
  type PhysicalValue,
  parsePhysicalValue,
  physicalFamilySchema,
  physicalPhase,
  physicalPlanSeal,
  physicalProgressSchema,
  physicalStageSchema,
  type RetainedFamily,
} from "./retained-state.ts";

const tableName = "fitness.account_erasure_identifier";

export const ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE = POSTGRES_IDENTIFIER_PAGE_SIZE;
export const ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS = {
  stringItem: 4 * 1024,
  decodedPage: 256 * 1024,
  wirePage: 1024 * 1024,
} as const;
// Auxiliary proof of the initial PG capture, not an executable phase or a
// mirrored row count. Later CH closure may add bindings to the same families.
const postgresCaptureCheckpoint = "postgres_identifier_capture";
const captureBindingSchema = z.object({ key_binding: z.string().nullable() });

function captureKeyBinding(requestId: string): string {
  return deriveCredentialKeyringIdentifier({
    tableName: "fitness.account_erasure_checkpoint",
    columnName: "key_binding",
    scopeId: requestId,
  });
}

function assertCaptureBinding(
  requestId: string,
  row: z.infer<typeof captureBindingSchema> | undefined,
) {
  if (!row) throw new Error("PostgreSQL parent identifier capture is incomplete");
  if (row.key_binding !== captureKeyBinding(requestId))
    throw new Error(
      "Account erasure retained key configuration changed. Restore the original key configuration before retrying.",
    );
}
const rowSchema = z.object({
  identity_key: cursorSchema,
  encrypted_identifier: z.string().startsWith("enc:v1:"),
});

export type AccountErasureIdentifierFamily = z.infer<typeof familySchema>;

export class AccountErasureIdentifierBudgetError extends Error {
  constructor(message: string) {
    super(`${message}. Contact support before retrying.`);
    this.name = "AccountErasureIdentifierBudgetError";
  }
}

function identifierKey(requestId: string, family: RetainedFamily, identifier: string): string {
  return deriveCredentialIdentifier(identifier, {
    tableName,
    columnName: "identity_key",
    scopeId: JSON.stringify([requestId, family]),
  });
}

function identifierEncryptionContext(requestId: string, family: RetainedFamily, key: string) {
  return {
    tableName,
    columnName: "encrypted_identifier",
    scopeId: JSON.stringify([requestId, family, key]),
  };
}

async function appendIdentifierValues(
  transaction: TransactionDatabase,
  requestId: string,
  family: RetainedFamily,
  values: readonly string[],
): Promise<boolean> {
  let wireBytes = 0;
  const rows = await Promise.all(
    values.map(async (identifier) => {
      const key = identifierKey(requestId, family, identifier);
      const encrypted = await encryptCredentialValue(
        identifier,
        identifierEncryptionContext(requestId, family, key),
      );
      wireBytes += Buffer.byteLength(encrypted, "utf8") + 128;
      return sql`(${requestId}::uuid,${family},${key},${encrypted})`;
    }),
  );
  if (wireBytes > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.wirePage)
    throw new AccountErasureIdentifierBudgetError(
      "Account erasure identifier page exceeds its encrypted wire byte budget",
    );
  if (rows.length === 0) return false;
  const inserted = await transaction.execute(sql`INSERT INTO fitness.account_erasure_identifier
    (request_id,family,identity_key,encrypted_identifier) VALUES ${sql.join(rows, sql`, `)}
    ON CONFLICT (request_id,family,identity_key) DO NOTHING RETURNING identity_key`);
  return inserted.length > 0;
}

/** Retained parent identities, scoped to the canonical deletion request. */
export class AccountErasureIdentifierStore {
  readonly #database: Pick<Database, "execute" | "transaction">;
  readonly #requestId: string;
  readonly #pageSize: number;
  readonly #leaseOwner: string;

  constructor(
    database: Pick<Database, "execute" | "transaction">,
    input: { requestId: string; pageSize: number; leaseOwner: string },
  ) {
    this.#database = database;
    this.#leaseOwner = z.string().min(1).max(200).parse(input.leaseOwner);
    this.#requestId = identifierSchema.parse(input.requestId);
    this.#pageSize = z
      .number()
      .int()
      .positive()
      .max(ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE)
      .parse(input.pageSize);
  }

  #pageCount(family: RetainedFamily): number {
    return family === "group_string" || isPhysicalFamily(family)
      ? Math.min(
          this.#pageSize,
          Math.floor(
            ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.decodedPage /
              ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem,
          ),
        )
      : this.#pageSize;
  }

  #value(family: RetainedFamily, value: string): string {
    if (isPhysicalFamily(family)) {
      if (Buffer.byteLength(value, "utf8") > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem)
        throw new AccountErasureIdentifierBudgetError(
          "Account erasure physical metadata exceeds its 4 KiB record limit",
        );
      const canonical = JSON.stringify(parsePhysicalValue(family, JSON.parse(value)));
      if (canonical !== value)
        throw new Error("Physical metadata must use canonical tuple encoding");
      return canonical;
    }
    if (family !== "group_string") return identifierSchema.parse(value);
    if (value.length > Math.ceil(ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem / 3) * 4)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier exceeds its 4 KiB String key limit",
      );
    z.string().min(1).base64().parse(value);
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    if ((value.length / 4) * 3 - padding > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier exceeds its 4 KiB String key limit",
      );
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.stringItem)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier exceeds its 4 KiB String key limit",
      );
    if (bytes.toString("base64") !== value)
      throw new Error("Account erasure String identifier must use canonical exact-byte base64");
    return value;
  }

  #identifiers(family: AccountErasureIdentifierFamily, values: readonly string[]): string[] {
    if (values.length > this.#pageCount(family))
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier page exceeds its count budget",
      );
    const identifiers = [...new Set(values.map((value) => this.#value(family, value)))];
    this.#assertDecodedBytes(family, identifiers);
    return identifiers;
  }

  #assertDecodedBytes(family: RetainedFamily, values: readonly string[]): void {
    const bytes = values.reduce(
      (sum, value) =>
        sum +
        (family === "group_string"
          ? Buffer.from(value, "base64").length
          : isPhysicalFamily(family)
            ? Buffer.byteLength(value, "utf8")
            : 36),
      0,
    );
    if (bytes > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.decodedPage)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier page exceeds its decoded byte budget",
      );
  }

  async #boundedRows(transaction: TransactionDatabase, condition: SQL, limit: number) {
    // Count-derived candidate limits bound valid decoded payloads. Check encrypted
    // wire size separately before returning any ciphertext, including corrupt rows.
    const [budget] = await executeWithSchema(
      transaction,
      z.object({ bytes: z.coerce.number().int().nonnegative() }),
      sql`
      SELECT coalesce(sum(octet_length(encrypted_identifier)+128),0) AS bytes FROM (
        SELECT encrypted_identifier FROM fitness.account_erasure_identifier
        WHERE ${condition} ORDER BY identity_key LIMIT ${limit}
      ) AS candidates`,
    );
    if (!budget || budget.bytes > ACCOUNT_ERASURE_IDENTIFIER_BYTE_LIMITS.wirePage)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure identifier page exceeds its encrypted wire byte budget",
      );
    return executeWithSchema(
      transaction,
      rowSchema,
      sql`
      SELECT identity_key,encrypted_identifier FROM fitness.account_erasure_identifier
      WHERE ${condition} ORDER BY identity_key LIMIT ${limit}`,
    );
  }

  async #assertRetainedRequest(transaction: TransactionDatabase, write: boolean): Promise<void> {
    const requests = await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`WITH locked AS MATERIALIZED (
          SELECT id,status,user_id,pii_scrubbed_at,lease_owner,lease_expires_at,
            encrypted_remote_snapshot IS NOT NULL AS retained_snapshot
          FROM fitness.account_erasure_request WHERE id=${this.#requestId}::uuid
          ${write ? sql`FOR UPDATE` : sql`FOR SHARE`}
        )
        SELECT id FROM locked WHERE status<>'completed'
          AND user_id IS NOT NULL AND retained_snapshot
          AND pii_scrubbed_at IS NULL
          AND lease_owner=${this.#leaseOwner} AND lease_expires_at>clock_timestamp()`,
    );
    if (requests.length !== 1) {
      throw new Error(
        "Account erasure request does not retain identifying state or its current worker lease",
      );
    }
    await this.#assertPostgresCapture(transaction);
  }

  async #decode(family: RetainedFamily, row: z.infer<typeof rowSchema>): Promise<string> {
    const identifier = this.#value(
      family,
      await decryptCredentialValue(
        row.encrypted_identifier,
        identifierEncryptionContext(this.#requestId, family, row.identity_key),
      ),
    );
    if (identifierKey(this.#requestId, family, identifier) !== row.identity_key) {
      throw new Error("Account erasure identifier does not match its retained identity key");
    }
    return identifier;
  }

  async #assertPostgresCapture(transaction: TransactionDatabase): Promise<void> {
    const rows = await executeWithSchema(
      transaction,
      captureBindingSchema,
      sql`SELECT details->>'keyBinding' AS key_binding FROM fitness.account_erasure_checkpoint
      WHERE request_id=${this.#requestId}::uuid AND phase=${postgresCaptureCheckpoint}
    `,
    );
    assertCaptureBinding(this.#requestId, rows[0]);
  }

  async #closureState(transaction: TransactionDatabase) {
    const rows = await executeWithSchema(
      transaction,
      z.object({ phase: z.string() }),
      sql`
      SELECT phase FROM fitness.account_erasure_checkpoint WHERE request_id=${this.#requestId}::uuid
        AND phase IN ('clickhouse_identity_closure_initial','clickhouse_identity_closure_final_open',
          'clickhouse_identity_closure_final','clickhouse_initial','peerdb_drain_verification')`,
    );
    return new Set(rows.map((row) => row.phase));
  }

  async beginClosure(stage: "initial" | "final"): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      await this.#assertRetainedRequest(transaction, true);
      const state = await this.#closureState(transaction);
      if (stage === "initial") {
        if (state.has("clickhouse_identity_closure_final_open"))
          throw new Error("Initial identity closure was reopened for final verification");
        return !state.has("clickhouse_identity_closure_initial");
      }
      if (
        !state.has("clickhouse_identity_closure_initial") ||
        !state.has("clickhouse_initial") ||
        !state.has("peerdb_drain_verification")
      )
        throw new Error(
          "Final identity closure requires completed initial erasure and PeerDB proof",
        );
      if (
        !(await this.#physicalPlanPrepared(transaction, "initial")) ||
        (await this.#physicalProgress(transaction, "initial"))?.step !== "complete"
      )
        throw new Error("Final identity closure requires initial physical metadata cleanup");
      if (state.has("clickhouse_identity_closure_final")) return false;
      await transaction.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase)
        VALUES (${this.#requestId}::uuid,'clickhouse_identity_closure_final_open') ON CONFLICT DO NOTHING`);
      return true;
    });
  }

  async #assertClosureWritable(transaction: TransactionDatabase): Promise<void> {
    const state = await this.#closureState(transaction);
    if (
      state.has("clickhouse_identity_closure_final") ||
      (state.has("clickhouse_identity_closure_initial") &&
        !state.has("clickhouse_identity_closure_final_open"))
    )
      throw new Error("Account erasure identity closure is sealed");
  }

  async sealClosure(stage: "initial" | "final"): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.#assertRetainedRequest(transaction, true);
      const state = await this.#closureState(transaction);
      if (stage === "final" && !state.has("clickhouse_identity_closure_final_open"))
        throw new Error("Final identity closure is not open");
      if (stage === "initial" && state.has("clickhouse_identity_closure_final_open"))
        throw new Error("Initial identity closure was reopened for final verification");
      await transaction.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase)
        VALUES (${this.#requestId}::uuid,${`clickhouse_identity_closure_${stage}`}) ON CONFLICT DO NOTHING`);
    });
  }

  async assertClosureComplete(stage: "initial" | "final"): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.#assertRetainedRequest(transaction, false);
      const state = await this.#closureState(transaction);
      if (stage === "initial" && state.has("clickhouse_identity_closure_final_open"))
        throw new Error("Initial identity closure was reopened for final verification");
      if (!state.has(`clickhouse_identity_closure_${stage}`))
        throw new Error("Account erasure identity closure is incomplete");
    });
  }

  async append(
    family: AccountErasureIdentifierFamily,
    identifiers: readonly string[],
  ): Promise<boolean> {
    familySchema.parse(family);
    const values = this.#identifiers(family, identifiers);
    return this.#database.transaction(async (transaction) => {
      await this.#assertRetainedRequest(transaction, true);
      await this.#assertClosureWritable(transaction);
      return appendIdentifierValues(transaction, this.#requestId, family, values);
    });
  }

  async readPage(
    family: AccountErasureIdentifierFamily,
    after?: string,
    through?: string,
  ): Promise<{ entries: Array<{ key: string; value: string }>; nextCursor: string | null }> {
    familySchema.parse(family);
    if (after !== undefined) cursorSchema.parse(after);
    if (through !== undefined) {
      cursorSchema.parse(through);
      if (after !== undefined && through <= after)
        throw new Error("Physical identity interval must increase");
    }
    return this.#database.transaction(async (transaction) => {
      await this.#assertRetainedRequest(transaction, false);
      const limit = this.#pageCount(family);
      const rows = await this.#boundedRows(
        transaction,
        sql`
        request_id=${this.#requestId}::uuid AND family=${family}
          ${after === undefined ? sql`` : sql`AND identity_key>${after}`}
          ${through === undefined ? sql`` : sql`AND identity_key<=${through}`}`,
        limit,
      );
      const entries = await Promise.all(
        rows.map(async (row) => ({
          key: row.identity_key,
          value: await this.#decode(family, row),
        })),
      );
      this.#assertDecodedBytes(
        family,
        entries.map((entry) => entry.value),
      );
      return {
        entries,
        nextCursor: rows.length === limit ? (rows.at(-1)?.identity_key ?? null) : null,
      };
    });
  }

  async #assertPhysicalAccess(
    transaction: TransactionDatabase,
    stage: AccountErasurePhysicalStage,
    write: boolean,
  ): Promise<void> {
    physicalStageSchema.parse(stage);
    await this.#assertRetainedRequest(transaction, write);
    const state = await this.#closureState(transaction);
    if (stage === "initial" && state.has("clickhouse_identity_closure_final_open"))
      throw new Error("Initial physical stage was reopened for final verification");
    if (!state.has(`clickhouse_identity_closure_${stage}`))
      throw new Error(`Physical stage ${stage} identity closure is incomplete`);
  }

  // Auxiliary admission proof; it neither dispatches work nor completes a public phase.
  async #physicalPlanPrepared(
    transaction: TransactionDatabase,
    stage: AccountErasurePhysicalStage,
  ): Promise<boolean> {
    const rows = await executeWithSchema(
      transaction,
      z.object({ present: z.boolean() }),
      sql`SELECT EXISTS (
      SELECT 1 FROM fitness.account_erasure_checkpoint WHERE request_id=${this.#requestId}::uuid AND phase=${physicalPlanSeal(stage)}
    ) AS present`,
    );
    return rows[0]?.present === true;
  }

  async #physicalProgress(
    transaction: TransactionDatabase,
    stage: AccountErasurePhysicalStage,
  ): Promise<AccountErasurePhysicalProgress | null> {
    const phase = physicalPhase(stage);
    const [row] = await executeWithSchema(
      transaction,
      z.object({ bytes: z.coerce.number().int().nonnegative(), details: z.unknown().nullable() }),
      sql`
      SELECT coalesce(octet_length((phase_progress->${phase})::text),0) AS bytes,
        CASE WHEN coalesce(octet_length((phase_progress->${phase})::text),0)<=4096 THEN phase_progress->${phase} ELSE NULL END AS details
      FROM fitness.account_erasure_request WHERE id=${this.#requestId}::uuid`,
    );
    if (!row || row.bytes > 4096)
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure physical progress exceeds its 4 KiB record limit",
      );
    return row.details === null ? null : physicalProgressSchema.parse(row.details);
  }

  async #preparedPhysicalProgress(
    transaction: TransactionDatabase,
    stage: AccountErasurePhysicalStage,
  ): Promise<AccountErasurePhysicalProgress> {
    if (!(await this.#physicalPlanPrepared(transaction, stage)))
      throw new Error("Account erasure physical preparation is incomplete");
    const progress = await this.#physicalProgress(transaction, stage);
    if (!progress) throw new Error("Account erasure physical preparation is incomplete");
    return progress;
  }

  async #savePhysicalProgress(
    transaction: TransactionDatabase,
    stage: AccountErasurePhysicalStage,
    previous: AccountErasurePhysicalProgress | null,
    next: AccountErasurePhysicalProgress,
  ): Promise<void> {
    physicalProgressSchema.parse(next);
    const phase = physicalPhase(stage);
    // The generic phase saver cannot atomically compare progress and retire an
    // encrypted descriptor; both writes remain in this request-locked transaction.
    const rows = await transaction.execute(sql`UPDATE fitness.account_erasure_request
      SET phase_progress=jsonb_set(phase_progress,ARRAY[${phase}],${JSON.stringify(next)}::jsonb,true),updated_at=now()
      WHERE id=${this.#requestId}::uuid AND lease_owner=${this.#leaseOwner} AND lease_expires_at>clock_timestamp() AND status<>'completed'
        AND (phase_progress->${phase}) IS NOT DISTINCT FROM ${previous === null ? null : JSON.stringify(previous)}::jsonb
      RETURNING id`);
    if (rows.length !== 1)
      throw new Error("Physical erasure progress cursor changed or its worker lease was lost");
  }

  async #readPhysicalPage(
    transaction: TransactionDatabase,
    family: PhysicalFamily,
    stage: AccountErasurePhysicalStage,
    after?: string,
  ): Promise<PhysicalPage<PhysicalValue>> {
    const limit = this.#pageCount(family);
    const rows = await this.#boundedRows(
      transaction,
      sql`request_id=${this.#requestId}::uuid AND family=${family}
      ${after === undefined ? sql`` : sql`AND identity_key>${after}`}`,
      limit,
    );
    const entries = [];
    for (const row of rows) {
      const value = parsePhysicalValue(family, JSON.parse(await this.#decode(family, row)));
      if (value[0] === stage) entries.push({ key: row.identity_key, value });
    }
    return {
      entries,
      nextCursor: rows.length === limit ? (rows.at(-1)?.identity_key ?? null) : null,
    };
  }

  async #readPhysicalEntry(
    transaction: TransactionDatabase,
    family: PhysicalFamily,
    stage: AccountErasurePhysicalStage,
    key: string,
  ): Promise<{ key: string; value: PhysicalValue } | null> {
    cursorSchema.parse(key);
    const [row] = await this.#boundedRows(
      transaction,
      sql`request_id=${this.#requestId}::uuid AND family=${family} AND identity_key=${key}`,
      1,
    );
    if (!row) return null;
    const value = parsePhysicalValue(family, JSON.parse(await this.#decode(family, row)));
    if (value[0] !== stage)
      throw new Error("Physical metadata stage does not match the requested stage");
    return { key: row.identity_key, value };
  }

  async #nextPhysicalEntry(
    transaction: TransactionDatabase,
    family: PhysicalFamily,
    stage: AccountErasurePhysicalStage,
    after: string | null,
  ) {
    let cursor = after ?? undefined;
    do {
      const page = await this.#readPhysicalPage(transaction, family, stage, cursor);
      if (page.entries.length > 0) return page.entries[0] ?? null;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }

  appendPhysical(
    family: "physical_intent",
    stage: AccountErasurePhysicalStage,
    values: readonly AccountErasurePhysicalIntent[],
  ): Promise<boolean>;
  appendPhysical(
    family: "physical_part",
    stage: AccountErasurePhysicalStage,
    values: readonly AccountErasurePhysicalPart[],
  ): Promise<boolean>;
  appendPhysical(
    family: "physical_mutation",
    stage: AccountErasurePhysicalStage,
    values: readonly AccountErasurePhysicalMutation[],
  ): Promise<boolean>;
  async appendPhysical(
    family: PhysicalFamily,
    stage: AccountErasurePhysicalStage,
    values: readonly PhysicalValue[],
  ): Promise<boolean> {
    physicalFamilySchema.parse(family);
    physicalStageSchema.parse(stage);
    if (values.length > this.#pageCount(family))
      throw new AccountErasureIdentifierBudgetError(
        "Account erasure physical metadata page exceeds its count budget",
      );
    const encoded = values.map((value) => {
      const canonical = JSON.stringify(parsePhysicalValue(family, value));
      const parsed = parsePhysicalValue(family, JSON.parse(this.#value(family, canonical)));
      if (parsed[0] !== stage)
        throw new Error("Physical metadata stage does not match the requested stage");
      return canonical;
    });
    this.#assertDecodedBytes(family, encoded);
    return this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const sealed = await this.#physicalPlanPrepared(transaction, stage);
      const progress = await this.#physicalProgress(transaction, stage);
      if (sealed !== Boolean(progress))
        throw new Error("Physical plan and progress admission seals disagree");
      if (family === "physical_intent" && sealed) throw new Error("Physical intent plan is sealed");
      if (progress && progress.step !== "apply")
        throw new Error("Physical metadata is frozen before global proof and cleanup");
      if (family === "physical_mutation") {
        if (progress?.step !== "apply" || !progress.pending?.admitted)
          throw new Error("Native mutation metadata requires an admitted physical intent");
        if (values.some((value) => value[1] !== progress.pending?.intentKey))
          throw new Error("Native mutation metadata does not belong to its admitted intent");
      }
      const inserted = await appendIdentifierValues(transaction, this.#requestId, family, encoded);
      if (
        family === "physical_mutation" &&
        encoded.length > 0 &&
        progress?.step === "apply" &&
        progress.pending &&
        progress.pending.mutationKey === null
      ) {
        const first = encoded[0];
        if (first === undefined) throw new Error("Missing mutation metadata page");
        await this.#savePhysicalProgress(transaction, stage, progress, {
          ...progress,
          pending: {
            ...progress.pending,
            mutationKey: identifierKey(this.#requestId, family, first),
          },
        });
      }
      return inserted;
    });
  }

  readPhysicalPage(
    family: "physical_intent",
    stage: AccountErasurePhysicalStage,
    after?: string,
  ): Promise<PhysicalPage<AccountErasurePhysicalIntent>>;
  readPhysicalPage(
    family: "physical_part",
    stage: AccountErasurePhysicalStage,
    after?: string,
  ): Promise<PhysicalPage<AccountErasurePhysicalPart>>;
  readPhysicalPage(
    family: "physical_mutation",
    stage: AccountErasurePhysicalStage,
    after?: string,
  ): Promise<PhysicalPage<AccountErasurePhysicalMutation>>;
  async readPhysicalPage(
    family: PhysicalFamily,
    stage: AccountErasurePhysicalStage,
    after?: string,
  ): Promise<PhysicalPage<PhysicalValue>> {
    physicalFamilySchema.parse(family);
    if (after !== undefined) cursorSchema.parse(after);
    return this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, false);
      return this.#readPhysicalPage(transaction, family, stage, after);
    });
  }

  readPhysicalEntry(
    family: "physical_intent",
    stage: AccountErasurePhysicalStage,
    key: string,
  ): Promise<{ key: string; value: AccountErasurePhysicalIntent } | null>;
  readPhysicalEntry(
    family: "physical_part",
    stage: AccountErasurePhysicalStage,
    key: string,
  ): Promise<{ key: string; value: AccountErasurePhysicalPart } | null>;
  readPhysicalEntry(
    family: "physical_mutation",
    stage: AccountErasurePhysicalStage,
    key: string,
  ): Promise<{ key: string; value: AccountErasurePhysicalMutation } | null>;
  async readPhysicalEntry(
    family: PhysicalFamily,
    stage: AccountErasurePhysicalStage,
    key: string,
  ): Promise<{ key: string; value: PhysicalValue } | null> {
    physicalFamilySchema.parse(family);
    return this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, false);
      return this.#readPhysicalEntry(transaction, family, stage, key);
    });
  }

  async #assertPhysicalSchema(
    transaction: TransactionDatabase,
    stage: AccountErasurePhysicalStage,
    schemaDigest: string,
  ): Promise<void> {
    const [row] = await executeWithSchema(
      transaction,
      z.object({ matches: z.boolean() }),
      sql`
      SELECT details=jsonb_build_object('schemaDigest',${schemaDigest}::text) AS matches
      FROM fitness.account_erasure_checkpoint
      WHERE request_id=${this.#requestId}::uuid AND phase=${physicalPlanSeal(stage)}`,
    );
    if (!row?.matches)
      throw new Error("ClickHouse physical plan schema changed; contact support before retrying");
  }

  async sealPhysicalPlan(stage: AccountErasurePhysicalStage, schemaDigest: string): Promise<void> {
    cursorSchema.parse(schemaDigest);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const previous = await this.#physicalProgress(transaction, stage);
      if (await this.#physicalPlanPrepared(transaction, stage)) {
        if (!previous) throw new Error("Physical preparation progress is incomplete");
        await this.#assertPhysicalSchema(transaction, stage, schemaDigest);
        return;
      }
      if (previous) throw new Error("Physical progress has no sealed plan");
      await transaction.execute(
        sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase,details) VALUES (${this.#requestId}::uuid,${physicalPlanSeal(stage)},${JSON.stringify({ schemaDigest })}::jsonb)`,
      );
      await this.#savePhysicalProgress(transaction, stage, null, {
        step: "apply",
        afterIntentKey: null,
        pending: null,
      });
    });
  }

  async assertPhysicalPlanPrepared(
    stage: AccountErasurePhysicalStage,
    schemaDigest: string,
  ): Promise<void> {
    cursorSchema.parse(schemaDigest);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, false);
      if (
        !(await this.#physicalPlanPrepared(transaction, stage)) ||
        !(await this.#physicalProgress(transaction, stage))
      )
        throw new Error("Account erasure physical preparation is incomplete");
      await this.#assertPhysicalSchema(transaction, stage, schemaDigest);
    });
  }

  async loadPhysicalProgress(
    stage: AccountErasurePhysicalStage,
  ): Promise<AccountErasurePhysicalProgress | null> {
    return this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, false);
      const progress = await this.#physicalProgress(transaction, stage);
      if ((await this.#physicalPlanPrepared(transaction, stage)) !== Boolean(progress))
        throw new Error("Physical plan and progress admission seals disagree");
      return progress;
    });
  }

  async startPhysicalIntent(
    stage: AccountErasurePhysicalStage,
    input: { expectedAfterKey: string | null; intentKey: string },
  ): Promise<void> {
    cursorSchema.nullable().parse(input.expectedAfterKey);
    cursorSchema.parse(input.intentKey);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (progress.step !== "apply" || progress.afterIntentKey !== input.expectedAfterKey)
        throw new Error("Physical apply cursor changed or preparation is incomplete");
      if (progress.pending) {
        if (progress.pending.intentKey === input.intentKey) return;
        throw new Error("Another physical intent is already pending");
      }
      const next = await this.#nextPhysicalEntry(
        transaction,
        "physical_intent",
        stage,
        input.expectedAfterKey,
      );
      if (next?.key !== input.intentKey)
        throw new Error("Physical intents must be admitted in canonical cursor order");
      await this.#savePhysicalProgress(transaction, stage, progress, {
        ...progress,
        pending: { intentKey: input.intentKey, admitted: false, mutationKey: null },
      });
    });
  }

  /** False means already admitted: recover its native evidence instead of issuing it again. */
  async admitPhysicalIntent(
    stage: AccountErasurePhysicalStage,
    intentKey: string,
  ): Promise<boolean> {
    cursorSchema.parse(intentKey);
    return this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (progress?.step !== "apply" || progress.pending?.intentKey !== intentKey)
        throw new Error("Physical intent is not pending for admission");
      if (progress.pending.admitted) return false;
      await this.#savePhysicalProgress(transaction, stage, progress, {
        ...progress,
        pending: { ...progress.pending, admitted: true },
      });
      return true;
    });
  }

  async finishPhysicalIntent(stage: AccountErasurePhysicalStage, intentKey: string): Promise<void> {
    cursorSchema.parse(intentKey);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (progress?.step !== "apply" || progress.pending?.intentKey !== intentKey)
        throw new Error("Physical intent is not pending");
      if (progress.pending.admitted) {
        const evidence =
          progress.pending.mutationKey === null
            ? null
            : await this.#readPhysicalEntry(
                transaction,
                "physical_mutation",
                stage,
                progress.pending.mutationKey,
              );
        if (!evidence || evidence.value[1] !== intentKey)
          throw new Error("Admitted physical intent has no native mutation evidence");
      }
      await this.#savePhysicalProgress(transaction, stage, progress, {
        step: "apply",
        afterIntentKey: intentKey,
        pending: null,
      });
    });
  }

  async finishPhysicalApply(
    stage: AccountErasurePhysicalStage,
    expectedAfterKey: string | null,
  ): Promise<void> {
    cursorSchema.nullable().parse(expectedAfterKey);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (
        progress?.step !== "apply" ||
        progress.afterIntentKey !== expectedAfterKey ||
        progress.pending
      )
        throw new Error("Physical apply cursor changed or an intent is pending");
      if (await this.#nextPhysicalEntry(transaction, "physical_intent", stage, expectedAfterKey))
        throw new Error("Physical plan still has unapplied intents");
      await this.#savePhysicalProgress(transaction, stage, progress, { step: "physical" });
    });
  }

  /** The native caller must first verify global all-state base/projection and residue proofs. */
  async markPhysicalComplete(stage: AccountErasurePhysicalStage): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (progress?.step !== "physical")
        throw new Error("Global physical completion requires all intents applied");
      await this.#savePhysicalProgress(transaction, stage, progress, {
        step: "cleanup",
        afterMutationKey: null,
      });
    });
  }

  /** Retire only after the native caller confirms this exact mutation metadata is absent. */
  async retirePhysicalMutation(
    stage: AccountErasurePhysicalStage,
    input: { key: string; expectedAfterKey: string | null },
  ): Promise<void> {
    cursorSchema.parse(input.key);
    cursorSchema.nullable().parse(input.expectedAfterKey);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (progress?.step !== "cleanup")
        throw new Error("Mutation cleanup requires durable global physical completion");
      if (progress.afterMutationKey !== input.expectedAfterKey)
        throw new Error("Physical cleanup cursor changed");
      const next = await this.#nextPhysicalEntry(
        transaction,
        "physical_mutation",
        stage,
        input.expectedAfterKey,
      );
      if (next?.key !== input.key)
        throw new Error("Physical cleanup descriptor does not match its canonical cursor");
      await transaction.execute(
        sql`DELETE FROM fitness.account_erasure_identifier WHERE request_id=${this.#requestId}::uuid AND family='physical_mutation' AND identity_key=${input.key}`,
      );
      await this.#savePhysicalProgress(transaction, stage, progress, {
        step: "cleanup",
        afterMutationKey: input.key,
      });
    });
  }

  async finishPhysicalCleanup(
    stage: AccountErasurePhysicalStage,
    expectedAfterKey: string | null,
  ): Promise<void> {
    cursorSchema.nullable().parse(expectedAfterKey);
    await this.#database.transaction(async (transaction) => {
      await this.#assertPhysicalAccess(transaction, stage, true);
      const progress = await this.#preparedPhysicalProgress(transaction, stage);
      if (progress?.step !== "cleanup" || progress.afterMutationKey !== expectedAfterKey)
        throw new Error("Physical cleanup cursor changed or completion is missing");
      if (await this.#nextPhysicalEntry(transaction, "physical_mutation", stage, expectedAfterKey))
        throw new Error("Physical mutation descriptors still require metadata cleanup");
      await this.#savePhysicalProgress(transaction, stage, progress, { step: "complete" });
    });
  }

  async findPresent(
    family: AccountErasureIdentifierFamily,
    identifiers: readonly string[],
  ): Promise<string[]> {
    familySchema.parse(family);
    const values = this.#identifiers(family, identifiers);
    return this.#database.transaction(async (transaction) => {
      await this.#assertRetainedRequest(transaction, false);
      if (values.length === 0) return [];
      const keys = values.map(
        (identifier) => sql`${identifierKey(this.#requestId, family, identifier)}`,
      );
      const rows = await this.#boundedRows(
        transaction,
        sql`
        request_id=${this.#requestId}::uuid AND family=${family}
          AND identity_key IN (${sql.join(keys, sql`, `)})`,
        this.#pageCount(family),
      );
      return Promise.all(rows.map((row) => this.#decode(family, row)));
    });
  }
}

/** Run inside activation's transaction and user-work barrier before parent deletion. */
export async function captureAccountErasurePostgresIdentifiers(
  transaction: TransactionDatabase,
  input: { requestId: string; userId: string },
): Promise<void> {
  const requestId = identifierSchema.parse(input.requestId);
  const userId = identifierSchema.parse(input.userId);
  const requests = await executeWithSchema(
    transaction,
    z.object({ id: z.uuid() }),
    sql`SELECT id
    FROM fitness.account_erasure_request
    WHERE id=${requestId}::uuid AND user_id=${userId}::uuid
      AND status<>'completed' AND encrypted_remote_snapshot IS NOT NULL
      AND pii_scrubbed_at IS NULL FOR UPDATE`,
  );
  const request = requests[0];
  if (!request)
    throw new Error("Account erasure request does not own the supplied PostgreSQL capture");
  const captured = await executeWithSchema(
    transaction,
    captureBindingSchema,
    sql`SELECT details->>'keyBinding' AS key_binding FROM fitness.account_erasure_checkpoint
      WHERE request_id=${requestId}::uuid AND phase=${postgresCaptureCheckpoint}`,
  );
  if (captured.length) {
    assertCaptureBinding(requestId, captured[0]);
    return;
  }
  const keyBinding = captureKeyBinding(requestId);

  for await (const page of listAccountErasurePostgresIdentifierPages(transaction, userId)) {
    await appendIdentifierValues(transaction, requestId, page.family, page.identifiers);
  }
  await transaction.execute(sql`INSERT INTO fitness.account_erasure_checkpoint(request_id,phase,details)
    VALUES (${requestId}::uuid,${postgresCaptureCheckpoint},${JSON.stringify({ keyBinding })}::jsonb)`);
}
