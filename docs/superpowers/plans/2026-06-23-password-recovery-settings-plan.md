# Password Recovery and Settings Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build password reset infrastructure, Settings password management on web and mobile, and move web Settings access from the sidebar nav to the lower-left user identity control.

**Architecture:** Add a single-use hashed password reset token table and service layer beside the existing password credential code. Reuse the existing Brevo SMTP/nodemailer infrastructure through a shared email transport helper. Keep public reset request/confirm endpoints as Express auth routes and authenticated set/change password as tRPC procedures.

**Tech Stack:** TypeScript, Express, tRPC, Drizzle SQL migrations, Vitest, React, React Native/Expo, TanStack Router, nodemailer/Brevo SMTP.

---

## File Structure

- Create `drizzle/0035_password_reset_token.sql`: password reset token table.
- Create `src/email.ts`: shared Brevo SMTP config and `sendPlainTextEmail`.
- Modify `src/export-email.ts`: use `sendPlainTextEmail`.
- Create `packages/server/src/auth/password-reset.ts`: token creation, token confirmation, and reset email delivery.
- Modify `packages/server/src/auth/password-credential.ts`: add credential status and authenticated set/change password helpers.
- Modify `packages/auth/src/auth.ts`: add Zod schemas for reset request/confirm and set-password inputs.
- Modify `packages/server/src/routes/auth/password-auth.ts`: add reset request/confirm route handlers.
- Modify `packages/server/src/routes/auth/index.ts`: register reset routes.
- Modify `packages/server/src/routers/auth.ts`: expose `passwordCredentialStatus` and `setPassword`.
- Modify `.env.example`: document `PUBLIC_URL`.
- Create tests beside changed server files.
- Modify `packages/web/src/lib/auth.ts`: add reset request/confirm helpers.
- Modify `packages/web/src/routes/login.tsx`: add forgot-password request flow.
- Create `packages/web/src/routes/reset-password.tsx`: public reset confirmation page.
- Modify `packages/web/src/routes/__root.tsx`: add `/reset-password` to public paths.
- Modify `packages/web/src/pages/SettingsPage.tsx`: add password management panel.
- Create `packages/web/src/components/PasswordSettingsPanel.tsx`: web password form.
- Create `packages/web/src/components/PasswordSettingsPanel.test.tsx`.
- Modify `packages/web/src/components/AppHeader.tsx`: remove Settings nav and link user/gear to Settings.
- Modify `packages/web/src/components/AppHeader.test.tsx`.
- Modify `packages/mobile/lib/auth.ts`: add reset request helper.
- Modify `packages/mobile/app/login.tsx`: add forgot-password request flow.
- Modify `packages/mobile/app/settings.tsx`: add password management section.
- Modify mobile tests for login/settings/auth helpers.

---

### Task 1: Shared Brevo Email Helper

**Files:**
- Create: `src/email.ts`
- Modify: `src/export-email.ts`
- Test: `src/email.test.ts`
- Test: `src/export-email.test.ts`

- [ ] **Step 1: Write the failing shared email tests**

Add `src/email.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendMail = vi.fn().mockResolvedValue({});
const mockCreateTransport = vi.fn(() => ({ sendMail: mockSendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: mockCreateTransport },
}));

const envBackup = { ...process.env };

async function loadEmailModule() {
  vi.resetModules();
  return import("./email.ts");
}

function setEmailEnv() {
  process.env.BREVO_SMTP_USER = "smtp-user";
  process.env.BREVO_SMTP_KEY = "smtp-key";
  process.env.EXPORT_EMAIL_FROM = "dofek@dofek.fit";
}

describe("shared email", () => {
  beforeEach(() => {
    process.env = { ...envBackup };
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({});
  });

  it("fails loudly when Brevo configuration is missing", async () => {
    const { sendPlainTextEmail } = await loadEmailModule();
    setEmailEnv();
    delete process.env.BREVO_SMTP_KEY;

    await expect(
      sendPlainTextEmail({
        subject: "Subject",
        text: "Body",
        toEmail: "user@example.com",
      }),
    ).rejects.toThrow("BREVO_SMTP_KEY");
  });

  it("sends a plain text email through Brevo SMTP", async () => {
    setEmailEnv();
    const { sendPlainTextEmail } = await loadEmailModule();

    await sendPlainTextEmail({
      subject: "Subject",
      text: "Body",
      toEmail: "user@example.com",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith({
      auth: { pass: "smtp-key", user: "smtp-user" },
      host: "smtp-relay.brevo.com",
      port: 587,
      secure: false,
    });
    expect(mockSendMail).toHaveBeenCalledWith({
      from: "dofek@dofek.fit",
      subject: "Subject",
      text: "Body",
      to: "user@example.com",
    });
  });
});
```

- [ ] **Step 2: Run the email test to verify it fails**

Run:

```bash
rtk pnpm vitest run --project unit src/email.test.ts
```

Expected: FAIL because `src/email.ts` does not exist.

- [ ] **Step 3: Implement the shared email helper**

Create `src/email.ts`:

```typescript
import nodemailer from "nodemailer";

interface PlainTextEmailInput {
  subject: string;
  text: string;
  toEmail: string;
}

interface BrevoSmtpConfig {
  fromEmail: string;
  smtpKey: string;
  smtpUser: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function readBrevoConfig(): BrevoSmtpConfig {
  return {
    fromEmail: requiredEnv("EXPORT_EMAIL_FROM"),
    smtpKey: requiredEnv("BREVO_SMTP_KEY"),
    smtpUser: requiredEnv("BREVO_SMTP_USER"),
  };
}

export async function sendPlainTextEmail(input: PlainTextEmailInput): Promise<void> {
  const config = readBrevoConfig();
  const transporter = nodemailer.createTransport({
    auth: { pass: config.smtpKey, user: config.smtpUser },
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
  });

  await transporter.sendMail({
    from: config.fromEmail,
    subject: input.subject,
    text: input.text,
    to: input.toEmail,
  });
}
```

Modify `src/export-email.ts`:

```typescript
import { formatDateMedium } from "@dofek/format/format";
import { sendPlainTextEmail } from "./email.ts";

interface ExportReadyEmailInput {
  downloadUrl: string;
  expiresAt: Date;
  toEmail: string;
}

export async function sendExportReadyEmail(input: ExportReadyEmailInput): Promise<void> {
  const expiresAt = formatDateMedium(input.expiresAt);

  await sendPlainTextEmail({
    subject: "Your Dofek export is ready",
    text: [
      "Your Dofek data export is ready.",
      "",
      `Download it here: ${input.downloadUrl}`,
      "",
      `This link and file expire on ${expiresAt}.`,
    ].join("\n"),
    toEmail: input.toEmail,
  });
}
```

Update `src/export-email.test.ts` so it mocks `./email.ts` instead of `nodemailer`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendPlainTextEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("./email.ts", () => ({
  sendPlainTextEmail: (input: unknown) => mockSendPlainTextEmail(input),
}));

async function loadEmailModule() {
  vi.resetModules();
  return import("./export-email.ts");
}

describe("export email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendPlainTextEmail.mockResolvedValue(undefined);
  });

  it("sends an export ready email with the signed export URL", async () => {
    const { sendExportReadyEmail } = await loadEmailModule();

    await sendExportReadyEmail({
      downloadUrl: "https://example.test/export",
      expiresAt: new Date("2026-05-03T12:00:00.000Z"),
      toEmail: "user@example.com",
    });

    expect(mockSendPlainTextEmail).toHaveBeenCalledWith({
      subject: "Your Dofek export is ready",
      text: expect.stringContaining("https://example.test/export"),
      toEmail: "user@example.com",
    });
    expect(mockSendPlainTextEmail.mock.calls[0]?.[0].text).toContain("May 3, 2026");
  });
});
```

- [ ] **Step 4: Run email tests to verify they pass**

Run:

```bash
rtk pnpm vitest run --project unit src/email.test.ts src/export-email.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/email.ts src/email.test.ts src/export-email.ts src/export-email.test.ts
rtk git commit -m "refactor: share smtp email helper"
```

---

### Task 2: Password Reset Persistence and Service

**Files:**
- Create: `drizzle/0035_password_reset_token.sql`
- Modify: `.env.example`
- Modify: `packages/auth/src/auth.ts`
- Create: `packages/server/src/auth/password-reset.ts`
- Test: `packages/server/src/auth/password-reset.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `packages/server/src/auth/password-reset.integration.test.ts`:

```typescript
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { authenticatePasswordUser, registerPasswordUser } from "./password-credential.ts";
import {
  createPasswordResetToken,
  InvalidPasswordResetTokenError,
  resetPasswordWithToken,
} from "./password-reset.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const mockSendPlainTextEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../../src/email.ts", () => ({
  sendPlainTextEmail: (input: unknown) => mockSendPlainTextEmail(input),
}));

describe("password reset service", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PUBLIC_URL = "https://app.example.test";
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
    await ctx.db.execute(sql`DELETE FROM fitness.password_reset_token`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_password_credential`);
    await ctx.db.execute(sql`DELETE FROM fitness.auth_account`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id != ${TEST_USER_ID}`);
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = NULL, name = 'Baseline User' WHERE id = ${TEST_USER_ID}`,
    );
  });

  it("creates a one-hour reset token and sends a reset email for an existing credential", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });

    const result = await createPasswordResetToken(ctx.db, "reset@example.com");

    expect(result.sent).toBe(true);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mockSendPlainTextEmail).toHaveBeenCalledWith({
      subject: "Reset your Dofek password",
      text: expect.stringContaining(`https://app.example.test/reset-password?token=${result.token}`),
      toEmail: "reset@example.com",
    });

    const rows = await ctx.db.execute<{ token_hash: string; expires_after_minutes: number }>(
      sql`SELECT token_hash, EXTRACT(EPOCH FROM (expires_at - created_at)) / 60 AS expires_after_minutes
          FROM fitness.password_reset_token`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(result.token);
    expect(Math.round(Number(rows[0]?.expires_after_minutes))).toBe(60);
  });

  it("does not send email or reveal existence for an unknown email", async () => {
    const result = await createPasswordResetToken(ctx.db, "missing@example.com");

    expect(result.sent).toBe(false);
    expect(result.token).toBeNull();
    expect(mockSendPlainTextEmail).not.toHaveBeenCalled();
  });

  it("resets the password and consumes the token", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    const result = await createPasswordResetToken(ctx.db, "reset@example.com");

    await resetPasswordWithToken(ctx.db, result.token ?? "", "new-password123");

    await expect(
      authenticatePasswordUser(ctx.db, "reset@example.com", "new-password123"),
    ).resolves.toEqual(expect.objectContaining({ userId: expect.any(String) }));
    await expect(
      resetPasswordWithToken(ctx.db, result.token ?? "", "another-password123"),
    ).rejects.toThrow(InvalidPasswordResetTokenError);
  });

  it("rejects expired reset tokens", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    const result = await createPasswordResetToken(ctx.db, "reset@example.com");
    await ctx.db.execute(sql`UPDATE fitness.password_reset_token SET expires_at = NOW() - INTERVAL '1 minute'`);

    await expect(
      resetPasswordWithToken(ctx.db, result.token ?? "", "new-password123"),
    ).rejects.toThrow(InvalidPasswordResetTokenError);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run:

```bash
rtk docker compose --env-file .env.local up -d db redis
rtk docker compose --env-file .env.local ps db redis
rtk pnpm vitest run packages/server/src/auth/password-reset.integration.test.ts
```

Expected: FAIL because the migration and service do not exist.

- [ ] **Step 3: Add schema and shared request schemas**

Create `drizzle/0035_password_reset_token.sql`:

```sql
CREATE TABLE fitness.password_reset_token (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT password_reset_token_pkey PRIMARY KEY (id),
  CONSTRAINT password_reset_token_token_hash_key UNIQUE (token_hash),
  CONSTRAINT password_reset_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES fitness.user_profile(id) ON DELETE CASCADE
);

CREATE INDEX password_reset_token_user_idx ON fitness.password_reset_token USING btree (user_id);
CREATE INDEX password_reset_token_active_idx ON fitness.password_reset_token USING btree (token_hash, expires_at) WHERE consumed_at IS NULL;
```

Add to `.env.example`:

```dotenv
# Public app URL used in emails such as password reset links
# PUBLIC_URL=https://health.yourdomain.com
```

Add to `packages/auth/src/auth.ts`:

```typescript
export const PasswordResetRequestSchema = z.object({
  email: z.string().trim().email(),
});

export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordResetConfirmSchema = z.object({
  password: z.string(),
  token: z.string().min(1),
});

export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmSchema>;

export const SetPasswordRequestSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string(),
});

export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;
```

- [ ] **Step 4: Implement password reset service**

Create `packages/server/src/auth/password-reset.ts`:

```typescript
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

const resetTokenRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
});

export class InvalidPasswordResetTokenError extends Error {
  constructor() {
    super("Reset link is invalid or has expired");
    this.name = "InvalidPasswordResetTokenError";
  }
}

export interface CreatePasswordResetTokenResult {
  sent: boolean;
  token: string | null;
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

function buildResetUrl(token: string): string {
  const baseUrl = requiredEnv("PUBLIC_URL").replace(/\/+$/, "");
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function createPasswordResetToken(
  db: Database,
  emailInput: string,
): Promise<CreatePasswordResetTokenResult> {
  const email = normalizeEmail(emailInput);
  const credentials = await executeWithSchema(
    db,
    credentialRowSchema,
    sql`SELECT user_id, email FROM fitness.user_password_credential
        WHERE email = ${email}
        LIMIT 1`,
  );
  const credential = credentials[0];
  if (!credential) {
    return { sent: false, token: null };
  }

  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  await db.execute(
    sql`INSERT INTO fitness.password_reset_token (user_id, token_hash, expires_at)
        VALUES (${credential.user_id}, ${tokenHash}, NOW() + INTERVAL '60 minutes')`,
  );

  await sendPlainTextEmail({
    subject: "Reset your Dofek password",
    text: [
      "Use this link to reset your Dofek password:",
      "",
      buildResetUrl(token),
      "",
      `This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`,
      "",
      "If you did not request this email, you can ignore it.",
    ].join("\n"),
    toEmail: credential.email,
  });

  return { sent: true, token };
}

export async function resetPasswordWithToken(
  db: Database,
  token: string,
  newPassword: string,
): Promise<void> {
  validatePassword(newPassword);
  const tokenHash = hashResetToken(token);

  await db.transaction(async (tx) => {
    const rows = await executeWithSchema(
      tx,
      resetTokenRowSchema,
      sql`SELECT id, user_id FROM fitness.password_reset_token
          WHERE token_hash = ${tokenHash}
            AND consumed_at IS NULL
            AND expires_at > NOW()
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      throw new InvalidPasswordResetTokenError();
    }

    await tx.execute(
      sql`UPDATE fitness.user_password_credential
          SET password_hash = ${hashPassword(newPassword)}, updated_at = NOW()
          WHERE user_id = ${row.user_id}`,
    );
    await tx.execute(
      sql`UPDATE fitness.password_reset_token
          SET consumed_at = NOW()
          WHERE id = ${row.id}`,
    );
  });
}
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run:

```bash
rtk pnpm vitest run packages/server/src/auth/password-reset.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add .env.example drizzle/0035_password_reset_token.sql packages/auth/src/auth.ts packages/server/src/auth/password-reset.ts packages/server/src/auth/password-reset.integration.test.ts
rtk git commit -m "feat: add password reset token service"
```

---

### Task 3: Authenticated Password Credential Management

**Files:**
- Modify: `packages/server/src/auth/password-credential.ts`
- Test: `packages/server/src/auth/password-credential.integration.test.ts`
- Modify: `packages/server/src/routers/auth.ts`
- Test: `packages/server/src/routers/auth.test.ts`

- [ ] **Step 1: Add failing credential management integration tests**

Extend the existing import from `./password-credential.ts` in `packages/server/src/auth/password-credential.integration.test.ts` so it includes the new exports:

```typescript
import {
  authenticatePasswordUser,
  DuplicateEmailError,
  getPasswordCredentialStatus,
  InvalidCredentialsError,
  registerPasswordUser,
  setPasswordForUser,
} from "./password-credential.ts";
```

Append this nested describe inside the existing `describe("password credential auth (integration)", () => { ... })` block, after the existing invalid credentials test:

```typescript

describe("authenticated password management", () => {
  it("creates a password credential for an OAuth-only user with a profile email", async () => {
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = 'oauth@example.com', name = 'OAuth User' WHERE id = ${TEST_USER_ID}`,
    );

    await expect(getPasswordCredentialStatus(ctx.db, TEST_USER_ID)).resolves.toEqual({
      hasPassword: false,
    });

    await setPasswordForUser(ctx.db, TEST_USER_ID, { newPassword: "new-password123" });

    await expect(
      authenticatePasswordUser(ctx.db, "oauth@example.com", "new-password123"),
    ).resolves.toEqual({ userId: TEST_USER_ID });
    await expect(getPasswordCredentialStatus(ctx.db, TEST_USER_ID)).resolves.toEqual({
      hasPassword: true,
    });
  });

  it("requires the current password when changing an existing password", async () => {
    const registered = await registerPasswordUser(ctx.db, {
      email: "change@example.com",
      password: "password123",
    });

    await expect(
      setPasswordForUser(ctx.db, registered.userId, { newPassword: "new-password123" }),
    ).rejects.toThrow("Current password is required");
  });

  it("changes an existing password when the current password is correct", async () => {
    const registered = await registerPasswordUser(ctx.db, {
      email: "change@example.com",
      password: "password123",
    });

    await setPasswordForUser(ctx.db, registered.userId, {
      currentPassword: "password123",
      newPassword: "new-password123",
    });

    await expect(
      authenticatePasswordUser(ctx.db, "change@example.com", "new-password123"),
    ).resolves.toEqual({ userId: registered.userId });
  });

  it("fails when an OAuth-only user has no profile email", async () => {
    await expect(
      setPasswordForUser(ctx.db, TEST_USER_ID, { newPassword: "new-password123" }),
    ).rejects.toThrow("Your account needs an email address before you can set a password");
  });
});
```

- [ ] **Step 2: Run the credential tests to verify they fail**

Run:

```bash
rtk pnpm vitest run packages/server/src/auth/password-credential.integration.test.ts
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement credential management helpers**

Add to `packages/server/src/auth/password-credential.ts`:

```typescript
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
```

- [ ] **Step 4: Add tRPC procedures**

Modify `packages/server/src/routers/auth.ts`:

```typescript
import { SetPasswordRequestSchema } from "@dofek/auth/auth";
import { TRPCError } from "@trpc/server";
import { queryCache } from "dofek/lib/cache";
import { z } from "zod";
import {
  getPasswordCredentialStatus,
  InvalidCredentialsError,
  MissingCurrentPasswordError,
  MissingProfileEmailError,
  setPasswordForUser,
} from "../auth/password-credential.ts";
import { InvalidPasswordError } from "../auth/password.ts";
import { AuthRepository } from "../repositories/auth-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const authRouter = router({
  passwordCredentialStatus: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    return getPasswordCredentialStatus(ctx.db, ctx.userId);
  }),

  setPassword: protectedProcedure.input(SetPasswordRequestSchema).mutation(async ({ ctx, input }) => {
    try {
      const result = await setPasswordForUser(ctx.db, ctx.userId, input);
      await queryCache.invalidateByPrefix(`${ctx.userId}:auth.passwordCredentialStatus`);
      return result;
    } catch (error: unknown) {
      if (
        error instanceof InvalidPasswordError ||
        error instanceof InvalidCredentialsError ||
        error instanceof MissingCurrentPasswordError ||
        error instanceof MissingProfileEmailError
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
      }
      throw error;
    }
  }),

  linkedAccounts: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new AuthRepository(ctx.db, ctx.userId);
    return repo.getLinkedAccounts();
  }),

  unlinkAccount: protectedProcedure
    .input(z.object({ accountId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new AuthRepository(ctx.db, ctx.userId);
      const count = await repo.getAccountCount();
      if (count < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot unlink your only login method",
        });
      }
      const deletedId = await repo.deleteAccount(input.accountId);
      if (!deletedId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      }
      await queryCache.invalidateByPrefix(`${ctx.userId}:auth.linkedAccounts`);
      return { ok: true };
    }),
});
```

- [ ] **Step 5: Run server tests**

Run:

```bash
rtk pnpm vitest run packages/server/src/auth/password-credential.integration.test.ts packages/server/src/routers/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/server/src/auth/password-credential.ts packages/server/src/auth/password-credential.integration.test.ts packages/server/src/routers/auth.ts packages/server/src/routers/auth.test.ts
rtk git commit -m "feat: add password settings api"
```

---

### Task 4: Public Password Reset Routes and Web Helpers

**Files:**
- Modify: `packages/server/src/routes/auth/password-auth.ts`
- Modify: `packages/server/src/routes/auth/index.ts`
- Test: `packages/server/src/routes/auth/password-auth.test.ts`
- Modify: `packages/web/src/lib/auth.ts`
- Test: `packages/web/src/lib/auth.test.ts`
- Modify: `packages/mobile/lib/auth.ts`
- Test: `packages/mobile/lib/auth.test.ts`

- [ ] **Step 1: Write failing route and client helper tests**

Add route tests to `packages/server/src/routes/auth/password-auth.test.ts` for:

```typescript
it("returns generic success for password reset requests", async () => {
  const { req, res } = createMockReqRes({
    body: { email: "user@example.com" },
    headers: { accept: "application/json" },
  });

  await handlePasswordResetRequest(req, res);

  expect(mockCreatePasswordResetToken).toHaveBeenCalledWith({}, "user@example.com");
  expect(res.json).toHaveBeenCalledWith({
    message: "If that email has a password login, we'll send a reset link.",
  });
});

it("confirms a password reset token", async () => {
  const { req, res } = createMockReqRes({
    body: { token: "reset-token", password: "new-password123" },
    headers: { accept: "application/json" },
  });

  await handlePasswordResetConfirm(req, res);

  expect(mockResetPasswordWithToken).toHaveBeenCalledWith({}, "reset-token", "new-password123");
  expect(res.json).toHaveBeenCalledWith({ ok: true });
});
```

Update the hoisted mocks in that file with:

```typescript
mockCreatePasswordResetToken: vi.fn(),
mockResetPasswordWithToken: vi.fn(),
```

and add:

```typescript
vi.mock("../../auth/password-reset.ts", () => ({
  createPasswordResetToken: (...args: unknown[]) => mockCreatePasswordResetToken(...args),
  resetPasswordWithToken: (...args: unknown[]) => mockResetPasswordWithToken(...args),
  InvalidPasswordResetTokenError: class InvalidPasswordResetTokenError extends Error {
    constructor() {
      super("Reset link is invalid or has expired");
      this.name = "InvalidPasswordResetTokenError";
    }
  },
}));
```

Add web helper tests in `packages/web/src/lib/auth.test.ts`:

```typescript
it("requests a password reset", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({ message: "If that email has a password login, we'll send a reset link." }),
  } as Response);

  await expect(requestPasswordReset("user@example.com")).resolves.toEqual({
    message: "If that email has a password login, we'll send a reset link.",
  });
});

it("confirms a password reset", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
  } as Response);

  await expect(confirmPasswordReset("token", "new-password123")).resolves.toEqual({ ok: true });
});
```

Add mobile helper tests in `packages/mobile/lib/auth.test.ts`:

```typescript
it("requests a password reset", async () => {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: () =>
      Promise.resolve({ message: "If that email has a password login, we'll send a reset link." }),
  } as Response);

  await expect(requestPasswordReset("https://server.test", "user@example.com")).resolves.toEqual({
    message: "If that email has a password login, we'll send a reset link.",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
rtk pnpm vitest run packages/server/src/routes/auth/password-auth.test.ts packages/web/src/lib/auth.test.ts packages/mobile/lib/auth.test.ts
```

Expected: FAIL because handlers and helpers do not exist.

- [ ] **Step 3: Implement Express handlers and route registration**

Add imports to `packages/server/src/routes/auth/password-auth.ts`:

```typescript
import { PasswordResetConfirmSchema, PasswordResetRequestSchema } from "@dofek/auth/auth";
import {
  createPasswordResetToken,
  InvalidPasswordResetTokenError,
  resetPasswordWithToken,
} from "../../auth/password-reset.ts";
```

Add handlers:

```typescript
const PASSWORD_RESET_REQUEST_MESSAGE =
  "If that email has a password login, we'll send a reset link.";

export async function handlePasswordResetRequest(req: Request, res: Response): Promise<void> {
  if (!isPasswordAuthEnabled()) {
    res.status(404).json({ error: "Password authentication is not enabled" });
    return;
  }

  try {
    const parsed = PasswordResetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendAuthError(res, 400, "Invalid password reset request");
      return;
    }
    await createPasswordResetToken(getDb(), parsed.data.email);
    res.json({ message: PASSWORD_RESET_REQUEST_MESSAGE });
  } catch (error: unknown) {
    Sentry.captureException(error);
    logger.error(`[auth] Password reset request failed: ${error}`);
    sendAuthError(res, 500, "Password reset request failed — please try again");
  }
}

export async function handlePasswordResetConfirm(req: Request, res: Response): Promise<void> {
  if (!isPasswordAuthEnabled()) {
    res.status(404).json({ error: "Password authentication is not enabled" });
    return;
  }

  try {
    const parsed = PasswordResetConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      sendAuthError(res, 400, "Invalid password reset details");
      return;
    }
    await resetPasswordWithToken(getDb(), parsed.data.token, parsed.data.password);
    res.json({ ok: true });
  } catch (error: unknown) {
    if (error instanceof InvalidPasswordResetTokenError || error instanceof InvalidPasswordError) {
      sendAuthError(res, 400, error.message);
      return;
    }
    Sentry.captureException(error);
    logger.error(`[auth] Password reset confirmation failed: ${error}`);
    sendAuthError(res, 500, "Password reset failed — please try again");
  }
}
```

Modify `packages/server/src/routes/auth/index.ts` import:

```typescript
import {
  handlePasswordLogin,
  handlePasswordRegister,
  handlePasswordResetConfirm,
  handlePasswordResetRequest,
} from "./password-auth.ts";
```

Register routes after password login/register:

```typescript
router.post(
  "/auth/password-reset/request",
  authRateLimiter,
  express.json(),
  handlePasswordResetRequest,
);
router.post(
  "/auth/password-reset/confirm",
  authRateLimiter,
  express.json(),
  handlePasswordResetConfirm,
);
```

- [ ] **Step 4: Implement web and mobile helpers**

Add to `packages/web/src/lib/auth.ts`:

```typescript
const resetRequestResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string(),
});

const resetConfirmResponseSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
});

export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  const response = await fetch("/auth/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  const data: unknown = await response.json().catch(() => null);
  const parsed = resetRequestResponseSchema.safeParse(data);
  if (!response.ok) {
    throw new Error(parsed.success && parsed.data.error ? parsed.data.error : "Password reset failed");
  }
  if (!parsed.success) {
    throw new Error("Password reset failed");
  }
  return { message: parsed.data.message };
}

export async function confirmPasswordReset(
  token: string,
  password: string,
): Promise<{ ok: true }> {
  const response = await fetch("/auth/password-reset/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, password }),
  });
  const data: unknown = await response.json().catch(() => null);
  const parsed = resetConfirmResponseSchema.safeParse(data);
  if (!response.ok) {
    throw new Error(parsed.success && parsed.data.error ? parsed.data.error : "Password reset failed");
  }
  if (!parsed.success || !parsed.data.ok) {
    throw new Error("Password reset failed");
  }
  return { ok: true };
}
```

Add to `packages/mobile/lib/auth.ts`:

```typescript
const PasswordResetResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string(),
});

export async function requestPasswordReset(
  serverUrl: string,
  email: string,
): Promise<{ message: string }> {
  const response = await fetch(`${serverUrl}/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email }),
  });
  const data: unknown = await response.json().catch(() => null);
  const parsed = PasswordResetResponseSchema.safeParse(data);
  if (!response.ok) {
    throw new Error(parsed.success && parsed.data.error ? parsed.data.error : "Password reset failed");
  }
  if (!parsed.success) {
    throw new Error("Password reset failed");
  }
  return { message: parsed.data.message };
}
```

- [ ] **Step 5: Run route and helper tests**

Run:

```bash
rtk pnpm vitest run packages/server/src/routes/auth/password-auth.test.ts packages/web/src/lib/auth.test.ts packages/mobile/lib/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/server/src/routes/auth/password-auth.ts packages/server/src/routes/auth/password-auth.test.ts packages/server/src/routes/auth/index.ts packages/web/src/lib/auth.ts packages/web/src/lib/auth.test.ts packages/mobile/lib/auth.ts packages/mobile/lib/auth.test.ts
rtk git commit -m "feat: add password reset endpoints"
```

---

### Task 5: Web UI for Reset, Settings Password, and Sidebar Entry

**Files:**
- Modify: `packages/web/src/routes/login.tsx`
- Create: `packages/web/src/routes/reset-password.tsx`
- Modify: `packages/web/src/routes/__root.tsx`
- Create: `packages/web/src/components/PasswordSettingsPanel.tsx`
- Create: `packages/web/src/components/PasswordSettingsPanel.test.tsx`
- Modify: `packages/web/src/pages/SettingsPage.tsx`
- Modify: `packages/web/src/components/AppHeader.tsx`
- Modify: `packages/web/src/components/AppHeader.test.tsx`
- Test: `packages/web/src/routes/-login.test.tsx`

- [ ] **Step 1: Write failing web tests**

Add to `packages/web/src/components/AppHeader.test.tsx`:

```typescript
it("does not include Settings in the main sidebar nav and links the user card to settings", () => {
  render(<AppHeader />);

  const sections = screen.getByRole("navigation", { name: "Sections" });
  expect(sections.textContent).not.toContain("Settings");

  const settingsLink = screen.getByLabelText("Open settings");
  expect(settingsLink.getAttribute("href")).toBe("/settings");
  expect(settingsLink.textContent).toContain("Ada Lovelace");
});
```

Create `packages/web/src/components/PasswordSettingsPanel.test.tsx`:

```typescript
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordSettingsPanel } from "./PasswordSettingsPanel.tsx";

const mockStatusQuery = vi.fn();
const mockSetPasswordMutation = vi.fn();
const mockInvalidate = vi.fn();

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    auth: {
      passwordCredentialStatus: { useQuery: () => mockStatusQuery() },
      setPassword: { useMutation: () => mockSetPasswordMutation() },
    },
    useUtils: () => ({ auth: { passwordCredentialStatus: { invalidate: mockInvalidate } } }),
  },
}));

describe("PasswordSettingsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sets a password for users without a password credential", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ hasPassword: true });
    mockStatusQuery.mockReturnValue({ data: { hasPassword: false }, isLoading: false, error: null });
    mockSetPasswordMutation.mockReturnValue({ mutateAsync, isPending: false, error: null });

    render(<PasswordSettingsPanel />);

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ newPassword: "new-password123" }),
    );
  });

  it("changes a password for users with a password credential", async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ hasPassword: true });
    mockStatusQuery.mockReturnValue({ data: { hasPassword: true }, isLoading: false, error: null });
    mockSetPasswordMutation.mockReturnValue({ mutateAsync, isPending: false, error: null });

    render(<PasswordSettingsPanel />);

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "password123" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new-password123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        currentPassword: "password123",
        newPassword: "new-password123",
      }),
    );
  });
});
```

Add login/reset route tests to existing route tests:

```typescript
it("shows forgot password in email sign-in mode", async () => {
  renderLoginRoute();
  await waitFor(() => expect(screen.getByRole("button", { name: "Forgot password?" })).toBeTruthy());
});
```

- [ ] **Step 2: Run web tests to verify they fail**

Run:

```bash
rtk pnpm vitest run --project unit packages/web/src/components/AppHeader.test.tsx packages/web/src/components/PasswordSettingsPanel.test.tsx packages/web/src/routes/-login.test.tsx
```

Expected: FAIL because the UI changes do not exist.

- [ ] **Step 3: Implement `PasswordSettingsPanel`**

Create `packages/web/src/components/PasswordSettingsPanel.tsx`:

```typescript
import { useState } from "react";
import { trpc } from "../lib/trpc.ts";

export function PasswordSettingsPanel() {
  const utils = trpc.useUtils();
  const status = trpc.auth.passwordCredentialStatus.useQuery();
  const setPassword = trpc.auth.setPassword.useMutation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const hasPassword = status.data?.hasPassword ?? false;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    setSuccess(null);
    if (newPassword !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }
    await setPassword.mutateAsync(
      {
        currentPassword: hasPassword ? currentPassword : undefined,
        newPassword,
      },
      {
        onSuccess: async () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
          setSuccess(hasPassword ? "Password changed." : "Password set.");
          await utils.auth.passwordCredentialStatus.invalidate();
        },
      },
    );
  }

  if (status.isLoading) {
    return <p className="text-sm text-subtle">Loading password status...</p>;
  }

  if (status.error) {
    return <p className="text-sm text-red-400">{status.error.message}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
      {hasPassword ? (
        <div>
          <label htmlFor="current-password" className="block text-xs text-muted mb-1">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
            autoComplete="current-password"
            className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
          />
        </div>
      ) : null}
      <div>
        <label htmlFor="new-password" className="block text-xs text-muted mb-1">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="block text-xs text-muted mb-1">
          Confirm password
        </label>
        <input
          id="confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
        />
      </div>
      {localError ? <p className="text-xs text-red-400">{localError}</p> : null}
      {setPassword.error ? <p className="text-xs text-red-400">{setPassword.error.message}</p> : null}
      {success ? <p className="text-xs text-accent">{success}</p> : null}
      <button
        type="submit"
        disabled={setPassword.isPending}
        className="px-3 py-2 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer"
      >
        {setPassword.isPending
          ? hasPassword
            ? "Changing password..."
            : "Setting password..."
          : hasPassword
            ? "Change password"
            : "Set password"}
      </button>
    </form>
  );
}
```

Add to `packages/web/src/pages/SettingsPage.tsx`:

```typescript
import { PasswordSettingsPanel } from "../components/PasswordSettingsPanel.tsx";
```

Place after Linked Accounts:

```tsx
<PageSection title="Password" subtitle="Set or change your email login password">
  <PasswordSettingsPanel />
</PageSection>
```

- [ ] **Step 4: Implement login forgot password and reset page**

In `packages/web/src/routes/login.tsx`, import `requestPasswordReset` and add a mode:

```typescript
type AuthMode = "login" | "register" | "reset";
```

Add reset submission:

```typescript
async function handlePasswordResetSubmit(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  setSubmitting(true);
  setFormError(null);
  try {
    const result = await requestPasswordReset(email);
    setFormError(result.message);
  } catch (err: unknown) {
    setFormError(err instanceof Error ? err.message : "Password reset failed");
  } finally {
    setSubmitting(false);
  }
}
```

Render a reset form when `authMode === "reset"` with email input and submit button labeled `Send reset link`. Keep a `Back to sign in` button that sets mode to `login`.

Create `packages/web/src/routes/reset-password.tsx`:

```typescript
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { confirmPasswordReset } from "../lib/auth.ts";

function ResetPasswordPage() {
  const { token } = useSearch({ from: "/reset-password" });
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      setSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-page flex items-center justify-center">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-surface-solid border border-border shadow-xl">
        <h1 className="text-2xl font-bold text-foreground text-center mb-6">Reset password</h1>
        {success ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-subtle">Your password has been reset.</p>
            <Link to="/login" className="text-sm text-accent hover:text-accent/80">
              Sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <label htmlFor="reset-password" className="block text-xs text-muted mb-1">
              New password
            </label>
            <input
              id="reset-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            />
            <label htmlFor="reset-password-confirm" className="block text-xs text-muted mb-1">
              Confirm password
            </label>
            <input
              id="reset-password-confirm"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent"
            />
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2 text-sm font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Resetting..." : "Reset password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: ResetPasswordPage,
});
```

Modify `packages/web/src/routes/__root.tsx`:

```typescript
const PUBLIC_PATHS = new Set(["/", "/login", "/privacy", "/reset-password"]);
```

- [ ] **Step 5: Implement sidebar settings entry**

Modify `packages/web/src/components/AppHeader.tsx`:

- Remove `{ to: "/settings", label: "Settings" }` from `navItems`.
- Wrap the lower-left user identity in a `Link to="/settings"` with `aria-label="Open settings"`.
- Add a small gear icon beside the name.
- Keep sign-out as a separate `button`.

Use this JSX inside the desktop user block:

```tsx
<div className="rounded-md border border-border bg-surface-solid/70 p-3">
  <Link
    to="/settings"
    aria-label="Open settings"
    className="flex items-center justify-between gap-2 text-foreground hover:text-accent transition-colors"
  >
    <span className="block truncate text-xs font-semibold">{user.name}</span>
    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M11.49 2.17a1.5 1.5 0 00-2.98 0l-.1.77a7.8 7.8 0 00-1.34.55l-.62-.47a1.5 1.5 0 00-2.1 2.1l.47.62a7.8 7.8 0 00-.55 1.34l-.77.1a1.5 1.5 0 000 2.98l.77.1c.13.47.31.92.55 1.34l-.47.62a1.5 1.5 0 002.1 2.1l.62-.47c.42.24.87.42 1.34.55l.1.77a1.5 1.5 0 002.98 0l.1-.77c.47-.13.92-.31 1.34-.55l.62.47a1.5 1.5 0 002.1-2.1l-.47-.62c.24-.42.42-.87.55-1.34l.77-.1a1.5 1.5 0 000-2.98l-.77-.1a7.8 7.8 0 00-.55-1.34l.47-.62a1.5 1.5 0 00-2.1-2.1l-.62.47a7.8 7.8 0 00-1.34-.55l-.1-.77zM10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"
        clipRule="evenodd"
      />
    </svg>
  </Link>
  <button
    type="button"
    onClick={logout}
    className="mt-1 text-xs text-subtle hover:text-foreground transition-colors cursor-pointer"
  >
    Sign out
  </button>
</div>
```

- [ ] **Step 6: Run web tests**

Run:

```bash
rtk pnpm vitest run --project unit packages/web/src/components/AppHeader.test.tsx packages/web/src/components/PasswordSettingsPanel.test.tsx packages/web/src/routes/-login.test.tsx packages/web/src/lib/auth.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/web/src/routes/login.tsx packages/web/src/routes/reset-password.tsx packages/web/src/routes/__root.tsx packages/web/src/components/PasswordSettingsPanel.tsx packages/web/src/components/PasswordSettingsPanel.test.tsx packages/web/src/pages/SettingsPage.tsx packages/web/src/components/AppHeader.tsx packages/web/src/components/AppHeader.test.tsx packages/web/src/routes/-login.test.tsx packages/web/src/lib/auth.ts packages/web/src/lib/auth.test.ts
rtk git commit -m "feat: add web password recovery ui"
```

---

### Task 6: Mobile Forgot Password and Settings Password UI

**Files:**
- Modify: `packages/mobile/app/login.tsx`
- Modify: `packages/mobile/app/login.test.tsx`
- Modify: `packages/mobile/app/settings.tsx`
- Modify: `packages/mobile/app/settings.test.tsx`

- [ ] **Step 1: Write failing mobile UI tests**

Add login test coverage in `packages/mobile/app/login.test.tsx`:

```typescript
it("requests a password reset from sign-in mode", async () => {
  mockFetchConfiguredProviders.mockResolvedValue({ identity: [], data: [], password: true });
  mockRequestPasswordReset.mockResolvedValue({
    message: "If that email has a password login, we'll send a reset link.",
  });

  const { getByText, getByPlaceholderText, findByText } = render(<LoginScreen />);

  fireEvent.press(await findByText("Forgot password?"));
  fireEvent.changeText(getByPlaceholderText("Email"), "user@example.com");
  fireEvent.press(getByText("Send reset link"));

  await waitFor(() =>
    expect(mockRequestPasswordReset).toHaveBeenCalledWith("http://localhost:3000", "user@example.com"),
  );
});
```

Add settings test coverage in `packages/mobile/app/settings.test.tsx`:

```typescript
it("renders set password controls when no password credential exists", async () => {
  mockPasswordCredentialStatusQuery.mockReturnValue({
    data: { hasPassword: false },
    isLoading: false,
    error: null,
  });

  const { findByText } = render(<SettingsScreen />);

  expect(await findByText("Password")).toBeTruthy();
  expect(await findByText("Set Password")).toBeTruthy();
});

it("renders change password controls when a password credential exists", async () => {
  mockPasswordCredentialStatusQuery.mockReturnValue({
    data: { hasPassword: true },
    isLoading: false,
    error: null,
  });

  const { findByText } = render(<SettingsScreen />);

  expect(await findByText("Current password")).toBeTruthy();
  expect(await findByText("Change Password")).toBeTruthy();
});
```

- [ ] **Step 2: Run mobile tests to verify they fail**

Run:

```bash
rtk pnpm test:mobile packages/mobile/app/login.test.tsx packages/mobile/app/settings.test.tsx
```

Expected: FAIL because the UI does not exist.

- [ ] **Step 3: Implement mobile forgot-password request**

In `packages/mobile/app/login.tsx`, import `requestPasswordReset`, add `resetMessage` state, and add a reset mode:

```typescript
type AuthMode = "login" | "register" | "reset";
```

Add:

```typescript
async function handlePasswordReset() {
  if (!serverUrl || loggingIn) return;

  setLoggingIn(true);
  setError(null);
  try {
    const result = await requestPasswordReset(serverUrl, email.trim());
    setError(result.message);
  } catch (err: unknown) {
    captureException(err, { source: "login-screen-password-reset" });
    setError(err instanceof Error ? err.message : "Password reset failed");
  } finally {
    setLoggingIn(false);
  }
}
```

Render a `Forgot password?` button in login mode. In reset mode, render email input, `Send reset link`, and `Back to sign in`.

- [ ] **Step 4: Implement mobile Settings password section**

In `packages/mobile/app/settings.tsx`, add:

```typescript
const passwordStatus = trpc.auth.passwordCredentialStatus.useQuery();
const setPasswordMutation = trpc.auth.setPassword.useMutation({
  onSuccess: async () => {
    await trpcUtils.auth.passwordCredentialStatus.invalidate();
    Alert.alert("Password Updated", "Your password has been saved.");
  },
  onError: (error) => Alert.alert("Error", error.message),
});
const [currentPassword, setCurrentPassword] = useState("");
const [newPassword, setNewPassword] = useState("");
const [confirmPassword, setConfirmPassword] = useState("");
```

Add handler:

```typescript
function handleSetPassword() {
  if (newPassword !== confirmPassword) {
    Alert.alert("Error", "Passwords do not match");
    return;
  }
  setPasswordMutation.mutate({
    currentPassword: passwordStatus.data?.hasPassword ? currentPassword : undefined,
    newPassword,
  });
}
```

Add a Password section near account/settings sections:

```tsx
<View style={styles.section}>
  <Text style={styles.sectionTitle}>Password</Text>
  <Text style={styles.sectionDescription}>Set or change your email login password</Text>
  {passwordStatus.isLoading ? (
    <ActivityIndicator color={colors.accent} size="small" />
  ) : passwordStatus.error ? (
    <Text style={styles.passwordErrorText}>{passwordStatus.error.message}</Text>
  ) : (
    <View style={styles.card}>
      {passwordStatus.data?.hasPassword ? (
        <TextInput
          style={styles.passwordInput}
          value={currentPassword}
          onChangeText={setCurrentPassword}
          placeholder="Current password"
          placeholderTextColor={colors.textSecondary}
          secureTextEntry
          autoComplete="password"
        />
      ) : null}
      <TextInput
        style={styles.passwordInput}
        value={newPassword}
        onChangeText={setNewPassword}
        placeholder="New password"
        placeholderTextColor={colors.textSecondary}
        secureTextEntry
        autoComplete="new-password"
      />
      <TextInput
        style={styles.passwordInput}
        value={confirmPassword}
        onChangeText={setConfirmPassword}
        placeholder="Confirm password"
        placeholderTextColor={colors.textSecondary}
        secureTextEntry
        autoComplete="new-password"
      />
      <TouchableOpacity
        style={[styles.passwordButton, setPasswordMutation.isPending && styles.buttonDisabled]}
        onPress={handleSetPassword}
        disabled={setPasswordMutation.isPending}
      >
        <Text style={styles.passwordButtonText}>
          {passwordStatus.data?.hasPassword ? "Change Password" : "Set Password"}
        </Text>
      </TouchableOpacity>
    </View>
  )}
</View>
```

Add these styles to the `StyleSheet.create` object in `packages/mobile/app/settings.tsx`:

```typescript
  passwordInput: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 12,
    color: colors.text,
    fontSize: 15,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  passwordErrorText: {
    color: colors.danger,
    fontSize: 12,
    marginBottom: 8,
  },
  passwordButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 12,
  },
  passwordButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
```

- [ ] **Step 5: Run mobile tests**

Run:

```bash
rtk pnpm test:mobile packages/mobile/app/login.test.tsx packages/mobile/app/settings.test.tsx packages/mobile/lib/auth.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/mobile/app/login.tsx packages/mobile/app/login.test.tsx packages/mobile/app/settings.tsx packages/mobile/app/settings.test.tsx packages/mobile/lib/auth.ts packages/mobile/lib/auth.test.ts
rtk git commit -m "feat: add mobile password recovery ui"
```

---

### Task 7: Final Verification and Push

**Files:**
- No new production files.
- Use all changed files from previous tasks.

- [ ] **Step 1: Ensure integration dependencies are running**

Run:

```bash
rtk docker compose --env-file .env.local up -d db redis clickhouse
rtk docker compose --env-file .env.local ps db redis clickhouse
```

Expected: `db`, `redis`, and `clickhouse` are `Up` and healthy.

- [ ] **Step 2: Run targeted tests**

Run:

```bash
rtk pnpm vitest run src/email.test.ts src/export-email.test.ts packages/server/src/auth/password-reset.integration.test.ts packages/server/src/auth/password-credential.integration.test.ts packages/server/src/routes/auth/password-auth.test.ts packages/server/src/routers/auth.test.ts packages/web/src/lib/auth.test.ts packages/web/src/components/AppHeader.test.tsx packages/web/src/components/PasswordSettingsPanel.test.tsx packages/web/src/routes/-login.test.tsx packages/mobile/lib/auth.test.ts
rtk pnpm test:mobile packages/mobile/app/login.test.tsx packages/mobile/app/settings.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run required pre-push checks**

Run:

```bash
rtk pnpm lint
```

Run from `/Users/ashercohen/conductor/workspaces/dofek/lima`:

```bash
rtk pnpm tsc --noEmit
```

Run from `/Users/ashercohen/conductor/workspaces/dofek/lima/packages/server`:

```bash
rtk pnpm tsc --noEmit
```

Run from `/Users/ashercohen/conductor/workspaces/dofek/lima/packages/web`:

```bash
rtk pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Update documentation**

Add a short note to `docs/app-password-auth.md`:

```markdown
## Password Recovery

Email/password users can request a password reset from the login screen. Reset links are sent through Brevo SMTP, expire after 1 hour, and are single-use. The server stores only a SHA-256 hash of each reset token in `fitness.password_reset_token`.

Authenticated users can set or change their password from Settings. OAuth-only users can set a password if their profile has an email address; users with an existing password must provide the current password.
```

- [ ] **Step 5: Commit docs if changed**

```bash
rtk git add docs/app-password-auth.md
rtk git commit -m "docs: document password recovery"
```

- [ ] **Step 6: Push**

Run:

```bash
rtk git push origin HEAD
```

Expected: branch pushes successfully.
