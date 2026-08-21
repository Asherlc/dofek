import { createHash, randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  withAccountErasureUserAndIdentityWriteFence,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { sendPlainTextEmail } from "../../../../src/email.ts";
import { getPublicUrlBase } from "../lib/public-url.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { hashPassword, normalizeEmail, validatePassword } from "./password.ts";
import { revokePasswordChangeAuthenticationMaterial } from "./password-change.ts";

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MINUTES = 60;

const credentialRowSchema = z.object({
  email: z.string(),
  user_id: z.string(),
});

const consumedTokenRowSchema = z.object({
  user_id: z.string(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result.rows)) {
    return result.rows;
  }
  throw new Error("Unexpected database execute result shape");
}

function parseRows<TSchema extends z.ZodType>(
  schema: TSchema,
  result: unknown,
): Array<z.infer<TSchema>> {
  return extractRows(result).map((row) => schema.parse(row));
}

export class InvalidPasswordResetTokenError extends Error {
  constructor() {
    super("Reset link is invalid or has expired");
    this.name = "InvalidPasswordResetTokenError";
  }
}

export interface CreatePasswordResetTokenResult {
  sent: boolean;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

function buildResetUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function createPasswordResetToken(
  db: Database,
  emailInput: string,
): Promise<CreatePasswordResetTokenResult> {
  const email = normalizeEmail(emailInput);
  const baseUrl = getPublicUrlBase();
  const credentials = await executeWithSchema(
    db,
    credentialRowSchema,
    sql`SELECT user_id, email FROM fitness.user_password_credential
        WHERE email = ${email}
        LIMIT 1`,
  );
  const credential = credentials[0];
  if (!credential) {
    return { sent: false };
  }

  let sent: boolean;
  try {
    sent = await withAccountErasureUserAndIdentityWriteFence(
      db,
      credential.user_id,
      [{ email, kind: "email" }],
      async (transaction) => {
        const currentCredentials = await executeWithSchema(
          transaction,
          credentialRowSchema,
          sql`SELECT user_id, email
              FROM fitness.user_password_credential
              WHERE user_id = ${credential.user_id}::uuid
                AND email = ${email}
              LIMIT 1`,
        );
        const currentCredential = currentCredentials[0];
        if (!currentCredential) return false;

        const token = generateResetToken();
        await transaction.execute(
          sql`INSERT INTO fitness.password_reset_token (user_id, token_hash, expires_at)
              VALUES (
                ${currentCredential.user_id}::uuid,
                ${hashResetToken(token)},
                NOW() + INTERVAL '60 minutes'
              )`,
        );
        await sendPlainTextEmail({
          subject: "Reset your Dofek password",
          text: [
            "Use this link to reset your Dofek password:",
            "",
            buildResetUrl(baseUrl, token),
            "",
            `This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`,
            "",
            "If you did not request this email, you can ignore it.",
          ].join("\n"),
          toEmail: currentCredential.email,
        });
        return true;
      },
    );
  } catch (error: unknown) {
    if (
      error instanceof AccountErasureIdentityFencedError ||
      error instanceof AccountErasureUserFencedError
    ) {
      return { sent: false };
    }
    throw error;
  }
  return { sent };
}

export async function resetPasswordWithToken(
  db: Database,
  token: string,
  newPassword: string,
): Promise<void> {
  validatePassword(newPassword);
  const tokenHash = hashResetToken(token);
  const candidateTokens = await executeWithSchema(
    db,
    consumedTokenRowSchema,
    sql`SELECT user_id
        FROM fitness.password_reset_token
        WHERE token_hash = ${tokenHash}
          AND consumed_at IS NULL
          AND expires_at > NOW()
        LIMIT 1`,
  );
  const candidateToken = candidateTokens[0];
  if (!candidateToken) {
    throw new InvalidPasswordResetTokenError();
  }

  try {
    await withAccountErasureUserWriteFence(db, candidateToken.user_id, async (tx) => {
      const rows = parseRows(
        consumedTokenRowSchema,
        await tx.execute(
          sql`UPDATE fitness.password_reset_token
            SET consumed_at = NOW()
            WHERE token_hash = ${tokenHash}
              AND consumed_at IS NULL
              AND expires_at > NOW()
            RETURNING user_id`,
        ),
      );
      const row = rows[0];
      if (!row) {
        throw new InvalidPasswordResetTokenError();
      }

      const updatedCredentials = parseRows(
        consumedTokenRowSchema,
        await tx.execute(
          sql`UPDATE fitness.user_password_credential
            SET password_hash = ${hashPassword(newPassword)}, updated_at = NOW()
            WHERE user_id = ${row.user_id}
            RETURNING user_id`,
        ),
      );
      if (!updatedCredentials[0]) {
        throw new InvalidPasswordResetTokenError();
      }

      await revokePasswordChangeAuthenticationMaterial(tx, row.user_id);
    });
  } catch (error: unknown) {
    if (error instanceof AccountErasureUserFencedError) {
      throw new InvalidPasswordResetTokenError();
    }
    throw error;
  }
}
