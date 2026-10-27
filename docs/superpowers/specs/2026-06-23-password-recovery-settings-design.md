# Password Recovery and Settings Password Design

## Goal

Add first-party password recovery for email/password accounts and let authenticated users set or change their password from Settings. Remove Settings from the main web sidebar navigation and make the lower-left user identity area the Settings entry point.

The feature must cover web and mobile parity for password recovery and password management. The web-only navigation change applies to the desktop sidebar.

## Current Context

- Email/password login and registration already exist through Express routes:
  - `POST /auth/register`
  - `POST /auth/login/password`
- Password credentials are stored in `fitness.user_password_credential`.
- Password hashing and validation live in `packages/server/src/auth/password.ts`.
- Password credential creation and authentication live in `packages/server/src/auth/password-credential.ts`.
- Settings screens exist on web and mobile.
- Export emails already use Brevo SMTP with `nodemailer` in `src/export-email.ts`, including fail-fast environment validation for missing SMTP configuration.
- The web sidebar currently exposes Settings as a normal navigation item and also shows the signed-in user in the lower-left corner.

## Server Design

Add a password reset token table:

- `id uuid primary key`
- `user_id uuid not null references fitness.user_profile(id) on delete cascade`
- `token_hash text not null unique`
- `expires_at timestamptz not null`
- `consumed_at timestamptz null`
- `created_at timestamptz not null default now()`

Store only a cryptographic hash of the raw reset token. The raw token is generated once, emailed to the user, and never persisted.

Add password reset service functions under `packages/server/src/auth/`:

- `createPasswordResetToken(db, email)`
  - Normalize the email.
  - Find a matching row in `fitness.user_password_credential`.
  - If no credential exists, return without revealing that fact.
  - Create a single-use token that expires after 1 hour.
  - Hash the token before storage.
  - Send a reset email using the existing Brevo SMTP infrastructure.
- `resetPasswordWithToken(db, token, newPassword)`
  - Hash the presented token and look up an unconsumed, unexpired token.
  - Validate the new password with the existing password policy.
  - Update the user's password hash in `fitness.user_password_credential`.
  - Mark the reset token consumed in the same transaction.

Add authenticated password management service behavior:

- `getPasswordCredentialStatus(db, userId)` returns whether the current user has a password credential.
- `setPasswordForUser(db, userId, input)`:
  - If the user already has a password credential, require `currentPassword` and verify it.
  - If the user has only OAuth login methods, allow creating a password with `newPassword` and no current password.
  - Use the user's profile email as the credential email. If the profile has no email, fail with a specific message.
  - Validate the new password with the existing password policy.
  - Upsert `fitness.user_password_credential`.

Add Express routes:

- `POST /auth/password-reset/request`
  - JSON body: `{ email: string }`
  - Always returns a generic success response when password auth is enabled:
    `If that email has a password login, we'll send a reset link.`
  - Does not reveal account existence.
- `POST /auth/password-reset/confirm`
  - JSON body: `{ token: string, password: string }`
  - Returns success after consuming the token and setting the password.
  - Returns clear errors for invalid, expired, or already-used reset links.

Add tRPC auth procedures:

- `auth.passwordCredentialStatus`
- `auth.setPassword`

These procedures are authenticated and user-scoped.

## Email Design

Reuse the existing Brevo SMTP setup instead of adding another mail provider. Extract shared email transport/config if needed so export email and password reset email do not duplicate SMTP setup.

Password reset email content:

- Subject: `Reset your Dofek password`
- Plain text only.
- Include a reset URL.
- Include the expiry window.
- State that the email can be ignored if the user did not request it.

The reset URL should be built from `PUBLIC_URL`, the canonical public app base URL environment variable.

## Web UX

Login page:

- In sign-in mode, show a `Forgot password?` control near the password field.
- The reset request form asks for email only.
- After submission, show the generic success message regardless of account existence.

Reset confirmation page:

- Add a public route that reads the reset token from the URL.
- The page asks for a new password.
- On success, show a concise success state with a link back to sign in.
- Show server-provided error messages for expired or invalid links.

Settings page:

- Add a Password section near Linked Accounts.
- If the user has no password credential, show a set-password form with new password and confirmation fields.
- If the user already has a password credential, show a change-password form with current password, new password, and confirmation fields.
- Display server error messages directly.

Sidebar:

- Remove `Settings` from the main nav items.
- Keep `/settings` as a valid route.
- Make the lower-left user identity area link to `/settings`.
- Add a small gear icon next to the user's name as the settings affordance.
- Keep sign-out as a separate button so clicking sign-out does not navigate to Settings.

## Mobile UX

Login screen:

- Add a forgot-password flow in sign-in mode.
- The request screen asks for email and shows the same generic success message.

Reset confirmation:

- Minimum parity is that mobile users can request a reset and complete it from the emailed web link.
- Do not add mobile deep-link reset confirmation in the first implementation; the emailed reset link opens the web reset page.

Settings screen:

- Add the same password status and set/change password behavior as web.
- Use native alerts or inline text consistent with the existing settings screen.

## Security and Error Handling

- Never store raw reset tokens.
- Reset tokens are single-use.
- Expired and consumed tokens cannot reset passwords.
- Password reset request does not reveal whether an account exists.
- Missing email configuration fails loudly when attempting to send a reset email.
- Unexpected server errors are captured in Sentry, following existing auth route patterns.
- Clients display specific server messages instead of generic hardcoded failures.

## Testing Plan

Server tests first:

- Creating a reset token sends email for an existing password credential.
- Requesting reset for an unknown email returns generic success and does not send email.
- Reset token confirmation updates the password.
- Reset token confirmation consumes the token.
- Consumed token cannot be reused.
- Expired token cannot be used.
- Setting a password for an OAuth-only user creates a password credential.
- Changing an existing password requires the current password.
- Wrong current password fails.
- Missing profile email fails with a specific message.

Web tests:

- Login page exposes forgot-password from sign-in mode.
- Reset request submits to the auth helper and shows the generic success message.
- Reset confirmation submits token and new password.
- Settings password panel renders set-password and change-password states.
- Sidebar no longer includes Settings in the main nav.
- Sidebar user/gear settings entry links to `/settings`.

Mobile tests:

- Login screen exposes forgot-password in sign-in mode.
- Mobile auth helper can request reset.
- Settings screen renders set-password and change-password states.
- Password mutation errors are surfaced to the user.

## Out of Scope

- Changing the existing password policy.
- Adding a second email provider.
- Passwordless login.
- Admin password reset controls.
- Enforcing current-password confirmation for OAuth-only users who do not yet have a password.
