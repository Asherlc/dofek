import type { Database } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { hashPassword, normalizeEmail, validatePassword, verifyPassword } from "./password.ts";
import { revokePasswordChangeAuthenticationMaterial } from "./password-change.ts";

export class DuplicateEmailError extends Error {
  constructor() {
    super("Unable to create an account with these details");
    this.name = "DuplicateEmailError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

export interface RegisterPasswordUserInput {
  email: string;
  password: string;
  name?: string | undefined;
}

export interface RegisterPasswordUserResult {
  userId: string;
  isNewUser: boolean;
}

export async function registerPasswordUser(
  db: Pick<Database, "execute">,
  input: RegisterPasswordUserInput,
  options?: { newUserId?: string },
): Promise<RegisterPasswordUserResult> {
  const email = normalizeEmail(input.email);
  validatePassword(input.password);

  const existingCredential = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`SELECT user_id FROM fitness.user_password_credential
        WHERE email = ${email}
        LIMIT 1`,
  );
  if (existingCredential.length > 0) {
    throw new DuplicateEmailError();
  }

  const existingUser = await executeWithSchema(
    db,
    z.object({ id: z.string(), name: z.string() }),
    sql`SELECT id, name FROM fitness.user_profile
        WHERE LOWER(email) = ${email}
        LIMIT 1`,
  );
  const matchedUser = existingUser[0];

  if (matchedUser) {
    throw new DuplicateEmailError();
  }

  const passwordHash = hashPassword(input.password);

  const displayName = input.name?.trim() || email.split("@")[0] || "User";
  const newUser = await executeWithSchema(
    db,
    z.object({ id: z.string() }),
    sql`INSERT INTO fitness.user_profile (id, name, email)
        VALUES (
          COALESCE(${options?.newUserId ?? null}::uuid, gen_random_uuid()),
          ${displayName},
          ${email}
        )
        RETURNING id`,
  );
  const newUserRow = newUser[0];
  if (!newUserRow) {
    throw new Error("Failed to create user profile");
  }

  await db.execute(
    sql`INSERT INTO fitness.user_password_credential (user_id, email, password_hash)
        VALUES (${newUserRow.id}, ${email}, ${passwordHash})`,
  );

  return { userId: newUserRow.id, isNewUser: true };
}

export async function authenticatePasswordUser(
  db: Database,
  emailInput: string,
  password: string,
): Promise<{ userId: string }> {
  const email = normalizeEmail(emailInput);

  const rows = await executeWithSchema(
    db,
    z.object({
      user_id: z.string(),
      password_hash: z.string(),
    }),
    sql`SELECT user_id, password_hash FROM fitness.user_password_credential
        WHERE email = ${email}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new InvalidCredentialsError();
  }

  return { userId: row.user_id };
}

export class MissingCurrentPasswordError extends Error {
  constructor() {
    super("Current password is required");
    this.name = "MissingCurrentPasswordError";
  }
}

export class MissingProfileEmailError extends Error {
  constructor() {
    super("Your account needs an email address before you can set a password");
    this.name = "MissingProfileEmailError";
  }
}

export interface PasswordCredentialStatus {
  hasPassword: boolean;
}

export interface SetPasswordForUserInput {
  currentPassword?: string | undefined;
  newPassword: string;
}

export async function getPasswordCredentialStatus(
  db: Database,
  userId: string,
): Promise<PasswordCredentialStatus> {
  const rows = await executeWithSchema(
    db,
    z.object({ user_id: z.string() }),
    sql`SELECT user_id FROM fitness.user_password_credential
        WHERE user_id = ${userId}
        LIMIT 1`,
  );
  return { hasPassword: rows.length > 0 };
}

export async function setPasswordForUser(
  db: Database,
  userId: string,
  input: SetPasswordForUserInput,
): Promise<PasswordCredentialStatus> {
  validatePassword(input.newPassword);
  return withAccountErasureUserWriteFence(db, userId, async (tx) => {
    const credentialRows = await executeWithSchema(
      tx,
      z.object({ email: z.string(), password_hash: z.string() }),
      sql`SELECT email, password_hash FROM fitness.user_password_credential
          WHERE user_id = ${userId}
          LIMIT 1`,
    );
    const credential = credentialRows[0];

    if (credential) {
      if (!input.currentPassword) {
        throw new MissingCurrentPasswordError();
      }
      if (!verifyPassword(input.currentPassword, credential.password_hash)) {
        throw new InvalidCredentialsError();
      }
      await tx.execute(
        sql`UPDATE fitness.user_password_credential
            SET password_hash = ${hashPassword(input.newPassword)}, updated_at = NOW()
            WHERE user_id = ${userId}`,
      );
      await revokePasswordChangeAuthenticationMaterial(tx, userId);
    } else {
      const profileRows = await executeWithSchema(
        tx,
        z.object({ email: z.string().nullable() }),
        sql`SELECT email FROM fitness.user_profile WHERE id = ${userId} LIMIT 1`,
      );
      const email = profileRows[0]?.email ? normalizeEmail(profileRows[0].email) : null;
      if (!email) {
        throw new MissingProfileEmailError();
      }

      await tx.execute(
        sql`INSERT INTO fitness.user_password_credential (user_id, email, password_hash)
            VALUES (${userId}, ${email}, ${hashPassword(input.newPassword)})`,
      );
    }

    return { hasPassword: true };
  });
}
