import {
  PasswordLoginRequestSchema,
  PasswordRegisterRequestSchema,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
} from "@dofek/auth/auth";
import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { setSessionCookie } from "../../auth/cookies.ts";
import { InvalidPasswordError } from "../../auth/password.ts";
import {
  authenticatePasswordUser,
  DuplicateEmailError,
  InvalidCredentialsError,
  isPasswordAuthEnabled,
  registerPasswordUser,
} from "../../auth/password-credential.ts";
import {
  createPasswordResetToken,
  InvalidPasswordResetTokenError,
  resetPasswordWithToken,
} from "../../auth/password-reset.ts";
import { createSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import { getDb, getPostLoginRedirect, isSafeRelativeRedirect, sanitizeReturnTo } from "./shared.ts";

function wantsJsonResponse(req: Request): boolean {
  const accept = req.headers.accept;
  if (typeof accept === "string" && accept.includes("application/json")) {
    return true;
  }
  return req.headers["content-type"]?.includes("application/json") ?? false;
}

function getRawReturnTo(req: Request): string | undefined {
  const queryReturnTo = typeof req.query.return_to === "string" ? req.query.return_to : undefined;
  const bodyReturnTo =
    req.body && typeof req.body.return_to === "string" ? req.body.return_to : undefined;
  return queryReturnTo ?? bodyReturnTo;
}

function getReturnTo(req: Request): string | undefined {
  return sanitizeReturnTo(getRawReturnTo(req));
}

function redirectAfterPasswordAuth(res: Response, req: Request, isNewUser: boolean): void {
  const candidate = getRawReturnTo(req);
  if (candidate && isSafeRelativeRedirect(candidate)) {
    res.redirect(candidate);
    return;
  }
  res.redirect(isNewUser ? "/?newUser=true" : "/");
}

function sendAuthError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export async function handlePasswordRegister(req: Request, res: Response): Promise<void> {
  if (!isPasswordAuthEnabled()) {
    res.status(404).json({ error: "Password authentication is not enabled" });
    return;
  }

  try {
    const parsed = PasswordRegisterRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendAuthError(res, 400, "Invalid registration details");
      return;
    }

    const db = getDb();
    const { userId, isNewUser } = await registerPasswordUser(db, parsed.data);
    const sessionInfo = await createSession(db, userId);
    const returnTo = getReturnTo(req);
    const redirectTo = getPostLoginRedirect(returnTo, isNewUser);

    logger.info(`[auth] User ${userId} registered with email/password`);

    if (wantsJsonResponse(req)) {
      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
      res.json({
        session: sessionInfo.sessionId,
        redirect: redirectTo,
        isNewUser,
      });
      return;
    }

    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    redirectAfterPasswordAuth(res, req, isNewUser);
  } catch (error: unknown) {
    if (error instanceof DuplicateEmailError) {
      sendAuthError(res, 409, error.message);
      return;
    }
    if (error instanceof InvalidPasswordError) {
      sendAuthError(res, 400, error.message);
      return;
    }
    Sentry.captureException(error);
    logger.error(`[auth] Password registration failed: ${error}`);
    sendAuthError(res, 500, "Registration failed — please try again");
  }
}

export async function handlePasswordLogin(req: Request, res: Response): Promise<void> {
  if (!isPasswordAuthEnabled()) {
    res.status(404).json({ error: "Password authentication is not enabled" });
    return;
  }

  try {
    const parsed = PasswordLoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendAuthError(res, 400, "Invalid login details");
      return;
    }

    const db = getDb();
    const { userId } = await authenticatePasswordUser(db, parsed.data.email, parsed.data.password);
    const sessionInfo = await createSession(db, userId);
    const returnTo = getReturnTo(req);
    const redirectTo = getPostLoginRedirect(returnTo, false);

    logger.info(`[auth] User ${userId} logged in with email/password`);

    if (wantsJsonResponse(req)) {
      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
      res.json({
        session: sessionInfo.sessionId,
        redirect: redirectTo,
        isNewUser: false,
      });
      return;
    }

    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    redirectAfterPasswordAuth(res, req, false);
  } catch (error: unknown) {
    if (error instanceof InvalidCredentialsError) {
      sendAuthError(res, 401, error.message);
      return;
    }
    Sentry.captureException(error);
    logger.error(`[auth] Password login failed: ${error}`);
    sendAuthError(res, 500, "Login failed — please try again");
  }
}

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
