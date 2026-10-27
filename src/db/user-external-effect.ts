import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const userExternalEffectSchema = z.discriminatedUnion("system", [
  z.strictObject({
    contactEmail: z.null().optional(),
    externalId: z.string().min(1),
    resourceType: z.literal("customer"),
    system: z.literal("stripe"),
    userId: z.uuid(),
  }),
  z.strictObject({
    contactEmail: z.string().email(),
    externalId: z.string().min(1),
    resourceType: z.literal("ticket"),
    system: z.literal("zoho_desk"),
    userId: z.uuid(),
  }),
]);

const userExternalEffectRowSchema = z.discriminatedUnion("system", [
  z.object({
    contactEmail: z.null(),
    externalId: z.string().min(1),
    resourceType: z.literal("customer"),
    system: z.literal("stripe"),
  }),
  z.object({
    contactEmail: z.string().email(),
    externalId: z.string().min(1),
    resourceType: z.literal("ticket"),
    system: z.literal("zoho_desk"),
  }),
]);
const idRowSchema = z.object({ id: z.uuid() });

export type UserExternalEffect = z.infer<typeof userExternalEffectSchema>;
export type UserExternalEffectReference = z.infer<typeof userExternalEffectRowSchema>;

export async function recordUserExternalEffect(
  database: SchemaExecutionDatabase,
  input: UserExternalEffect,
): Promise<void> {
  const effect = userExternalEffectSchema.parse(input);
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`INSERT INTO fitness.user_external_effect (
          user_id, system, resource_type, external_id, contact_email
        )
        VALUES (
          ${effect.userId}::uuid,
          ${effect.system},
          ${effect.resourceType},
          ${effect.externalId},
          ${effect.system === "zoho_desk" ? effect.contactEmail : null}
        )
        ON CONFLICT (system, resource_type, external_id) DO UPDATE
          SET
            user_id = EXCLUDED.user_id,
            contact_email = EXCLUDED.contact_email
          WHERE fitness.user_external_effect.user_id = EXCLUDED.user_id
        RETURNING id`,
  );
  if (rows.length !== 1) {
    throw new Error(
      `${effect.system} ${effect.resourceType} ${effect.externalId} is already attributed to another user`,
    );
  }
}

export async function listUserExternalEffects(
  database: SchemaExecutionDatabase,
  userId: string,
): Promise<UserExternalEffectReference[]> {
  return executeWithSchema(
    database,
    userExternalEffectRowSchema,
    sql`SELECT
          system,
          contact_email AS "contactEmail",
          resource_type AS "resourceType",
          external_id AS "externalId"
        FROM fitness.user_external_effect
        WHERE user_id = ${userId}::uuid
        ORDER BY system, resource_type, external_id`,
  );
}
