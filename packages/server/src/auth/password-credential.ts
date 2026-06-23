import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { hashPassword, normalizeEmail, validatePassword, verifyPassword } from "./password.ts";

export class DuplicateEmailError extends Error {
  constructor() {
    super("An account with this email already exists");
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
  db: Database,
  input: RegisterPasswordUserInput,
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

  const passwordHash = hashPassword(input.password);

  if (matchedUser) {
    await db.execute(
      sql`INSERT INTO fitness.user_password_credential (user_id, email, password_hash)
          VALUES (${matchedUser.id}, ${email}, ${passwordHash})`,
    );
    return { userId: matchedUser.id, isNewUser: false };
  }

  const displayName = input.name?.trim() || email.split("@")[0] || "User";
  const newUser = await executeWithSchema(
    db,
    z.object({ id: z.string() }),
    sql`INSERT INTO fitness.user_profile (name, email)
        VALUES (${displayName}, ${email})
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

export function isPasswordAuthEnabled(): boolean {
  return process.env.ENABLE_PASSWORD_AUTH !== "false";
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
  const credentialRows = await executeWithSchema(
    db,
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
    await db.execute(
      sql`UPDATE fitness.user_password_credential
          SET password_hash = ${hashPassword(input.newPassword)}, updated_at = NOW()
          WHERE user_id = ${userId}`,
    );
    return { hasPassword: true };
  }

  const profileRows = await executeWithSchema(
    db,
    z.object({ email: z.string().nullable() }),
    sql`SELECT email FROM fitness.user_profile WHERE id = ${userId} LIMIT 1`,
  );
  const email = profileRows[0]?.email ? normalizeEmail(profileRows[0].email) : null;
  if (!email) {
    throw new MissingProfileEmailError();
  }

  await db.execute(
    sql`INSERT INTO fitness.user_password_credential (user_id, email, password_hash)
        VALUES (${userId}, ${email}, ${hashPassword(input.newPassword)})`,
  );
  return { hasPassword: true };
}
