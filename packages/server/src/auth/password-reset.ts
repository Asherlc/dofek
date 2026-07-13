import { createHash, randomBytes } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { sendPlainTextEmail } from "../../../../src/email.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { hashPassword, normalizeEmail, validatePassword } from "./password.ts";

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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

function readPublicAppBaseUrl(): string {
  const baseUrl = requiredEnv("PUBLIC_URL").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("PUBLIC_URL environment variable is required");
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new Error("PUBLIC_URL environment variable must be a valid URL");
  }
  return baseUrl;
}

function buildResetUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function createPasswordResetToken(
  db: Database,
  emailInput: string,
): Promise<CreatePasswordResetTokenResult> {
  const email = normalizeEmail(emailInput);
  const baseUrl = readPublicAppBaseUrl();
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

  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  const resetUrl = buildResetUrl(baseUrl, token);
  await db.execute(
    sql`INSERT INTO fitness.password_reset_token (user_id, token_hash, expires_at)
        VALUES (${credential.user_id}, ${tokenHash}, NOW() + INTERVAL '60 minutes')`,
  );

  await sendPlainTextEmail({
    subject: "Reset your Dofek password",
    text: [
      "Use this link to reset your Dofek password:",
      "",
      resetUrl,
      "",
      `This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`,
      "",
      "If you did not request this email, you can ignore it.",
    ].join("\n"),
    toEmail: credential.email,
  });

  return { sent: true };
}

export async function resetPasswordWithToken(
  db: Database,
  token: string,
  newPassword: string,
): Promise<void> {
  validatePassword(newPassword);
  const tokenHash = hashResetToken(token);

  await db.transaction(async (tx) => {
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
  });
}
