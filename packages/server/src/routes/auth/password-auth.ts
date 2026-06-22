import { PasswordLoginRequestSchema, PasswordRegisterRequestSchema } from "@dofek/auth/auth";
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
import { createSession } from "../../auth/session.ts";
import { logger } from "../../logger.ts";
import { getDb, sanitizeReturnTo } from "./shared.ts";

function wantsJsonResponse(req: Request): boolean {
  const accept = req.headers.accept;
  if (typeof accept === "string" && accept.includes("application/json")) {
    return true;
  }
  return req.headers["content-type"]?.includes("application/json") ?? false;
}

function getReturnTo(req: Request): string | undefined {
  const queryReturnTo = typeof req.query.return_to === "string" ? req.query.return_to : undefined;
  const bodyReturnTo =
    req.body && typeof req.body.return_to === "string" ? req.body.return_to : undefined;
  return sanitizeReturnTo(queryReturnTo ?? bodyReturnTo);
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
    const { userId } = await registerPasswordUser(db, parsed.data);
    const sessionInfo = await createSession(db, userId);
    const returnTo = getReturnTo(req);

    logger.info(`[auth] User ${userId} registered with email/password`);

    if (wantsJsonResponse(req)) {
      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
      res.json({
        session: sessionInfo.sessionId,
        redirect: returnTo ?? "/",
      });
      return;
    }

    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    res.redirect("/");
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

    logger.info(`[auth] User ${userId} logged in with email/password`);

    if (wantsJsonResponse(req)) {
      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
      res.json({
        session: sessionInfo.sessionId,
        redirect: returnTo ?? "/",
      });
      return;
    }

    setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);
    res.redirect("/");
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
