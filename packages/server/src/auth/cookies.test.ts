import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  clearOAuthFlowCookies,
  clearSessionCookie,
  getLinkUserCookie,
  getMobileSchemeCookie,
  getOAuthFlowCookies,
  getSessionCookie,
  getSessionIdFromRequest,
  isValidMobileScheme,
  setLinkUserCookie,
  setMobileSchemeCookie,
  setOAuthFlowCookies,
  setSessionCookie,
} from "./cookies.ts";

/** Create a mock Express Request with optional cookies and headers */
function mockRequest(
  cookies?: Record<string, string | undefined>,
  headers?: Record<string, string | undefined>,
): Request {
  const req: Request = Object.assign(Object.create(null), {
    cookies,
    headers: headers ?? {},
  });
  return req;
}

/** Create a mock Express Response that tracks cookie operations */
function mockResponse(): Response & {
  cookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
} {
  const res = {
    cookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  } satisfies Partial<Response>;
  const result: Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  } = Object.assign(Object.create(null), res);
  return result;
}

describe("Auth cookies", () => {
  describe("setSessionCookie", () => {
    it("sets a session cookie with the correct options", () => {
      const res = mockResponse();
      const expiresAt = new Date("2026-04-01T00:00:00Z");

      setSessionCookie(res, "session-abc-123", expiresAt);

      expect(res.cookie).toHaveBeenCalledWith("session", "session-abc-123", {
        httpOnly: true,
        secure: false, // NODE_ENV is not production in tests
        sameSite: "lax",
        path: "/",
        expires: expiresAt,
      });
    });

    it("passes the exact session ID without modification", () => {
      const res = mockResponse();
      const sessionId = "a".repeat(64);

      setSessionCookie(res, sessionId, new Date());

      expect(res.cookie).toHaveBeenCalledWith("session", sessionId, expect.any(Object));
    });
  });

  describe("getSessionCookie", () => {
    it("returns the session cookie value when present", () => {
      const req = mockRequest({ session: "my-session-id" });
      expect(getSessionCookie(req)).toBe("my-session-id");
    });

    it("returns undefined when session cookie is missing", () => {
      const req = mockRequest({});
      expect(getSessionCookie(req)).toBeUndefined();
    });

    it("returns undefined when req.cookies is undefined", () => {
      const req = mockRequest(undefined);
      expect(getSessionCookie(req)).toBeUndefined();
    });
  });

  describe("clearSessionCookie", () => {
    it("clears the session cookie with correct path", () => {
      const res = mockResponse();

      clearSessionCookie(res);

      expect(res.clearCookie).toHaveBeenCalledWith("session", { path: "/" });
    });
  });

  describe("setOAuthFlowCookies", () => {
    it("sets both state and code_verifier cookies", () => {
      const res = mockResponse();

      setOAuthFlowCookies(res, "state-xyz", "verifier-abc");

      expect(res.cookie).toHaveBeenCalledTimes(2);

      // State cookie
      expect(res.cookie).toHaveBeenCalledWith("auth_state", "state-xyz", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 10 * 60 * 1000,
      });

      // Code verifier cookie
      expect(res.cookie).toHaveBeenCalledWith("auth_code_verifier", "verifier-abc", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 10 * 60 * 1000,
      });
    });
  });

  describe("getOAuthFlowCookies", () => {
    it("returns both state and codeVerifier when present", () => {
      const req = mockRequest({
        auth_state: "my-state",
        auth_code_verifier: "my-verifier",
      });

      const result = getOAuthFlowCookies(req);

      expect(result).toEqual({
        state: "my-state",
        codeVerifier: "my-verifier",
      });
    });

    it("returns undefined for missing cookies", () => {
      const req = mockRequest({});

      const result = getOAuthFlowCookies(req);

      expect(result).toEqual({
        state: undefined,
        codeVerifier: undefined,
      });
    });

    it("returns partial results when only some cookies exist", () => {
      const req = mockRequest({ auth_state: "only-state" });

      const result = getOAuthFlowCookies(req);

      expect(result).toEqual({
        state: "only-state",
        codeVerifier: undefined,
      });
    });
  });

  describe("clearOAuthFlowCookies", () => {
    it("clears state, code_verifier, link_user, and mobile_scheme cookies", () => {
      const res = mockResponse();

      clearOAuthFlowCookies(res);

      expect(res.clearCookie).toHaveBeenCalledTimes(4);
      expect(res.clearCookie).toHaveBeenCalledWith("auth_state", { path: "/" });
      expect(res.clearCookie).toHaveBeenCalledWith("auth_code_verifier", {
        path: "/",
      });
      expect(res.clearCookie).toHaveBeenCalledWith("auth_link_user", {
        path: "/",
      });
      expect(res.clearCookie).toHaveBeenCalledWith("auth_mobile_scheme", {
        path: "/",
      });
    });
  });

  describe("setLinkUserCookie", () => {
    it("sets the link user cookie", () => {
      const res = mockResponse();
      setLinkUserCookie(res, "user-123");
      expect(res.cookie).toHaveBeenCalledWith("auth_link_user", "user-123", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 10 * 60 * 1000,
      });
    });
  });

  describe("getLinkUserCookie", () => {
    it("returns the link user cookie when present", () => {
      const req = mockRequest({ auth_link_user: "user-456" });
      expect(getLinkUserCookie(req)).toBe("user-456");
    });

    it("returns undefined when cookie is missing", () => {
      const req = mockRequest({});
      expect(getLinkUserCookie(req)).toBeUndefined();
    });

    it("returns undefined for non-string cookie value", () => {
      const req = mockRequest(undefined);
      expect(getLinkUserCookie(req)).toBeUndefined();
    });
  });

  describe("getSessionIdFromRequest", () => {
    it("returns session from cookie when present", () => {
      const req = mockRequest({ session: "cookie-session" });
      expect(getSessionIdFromRequest(req)).toBe("cookie-session");
    });

    it("returns session from Authorization header when no cookie", () => {
      const req = mockRequest({}, { authorization: "Bearer header-session" });
      expect(getSessionIdFromRequest(req)).toBe("header-session");
    });

    it("prefers cookie over Authorization header", () => {
      const req = mockRequest(
        { session: "cookie-session" },
        { authorization: "Bearer header-session" },
      );
      expect(getSessionIdFromRequest(req)).toBe("cookie-session");
    });

    it("returns undefined when neither cookie nor header is present", () => {
      const req = mockRequest({});
      expect(getSessionIdFromRequest(req)).toBeUndefined();
    });

    it("ignores non-Bearer authorization headers", () => {
      const req = mockRequest({}, { authorization: "Basic dXNlcjpwYXNz" });
      expect(getSessionIdFromRequest(req)).toBeUndefined();
    });

    it("ignores empty Bearer token", () => {
      const req = mockRequest({}, { authorization: "Bearer " });
      expect(getSessionIdFromRequest(req)).toBeUndefined();
    });
  });

  describe("setMobileSchemeCookie", () => {
    it("sets the mobile scheme cookie", () => {
      const res = mockResponse();
      setMobileSchemeCookie(res, "dofek");
      expect(res.cookie).toHaveBeenCalledWith("auth_mobile_scheme", "dofek", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 10 * 60 * 1000,
      });
    });
  });

  describe("getMobileSchemeCookie", () => {
    it("returns the mobile scheme when present", () => {
      const req = mockRequest({ auth_mobile_scheme: "dofek" });
      expect(getMobileSchemeCookie(req)).toBe("dofek");
    });

    it("returns undefined when missing", () => {
      const req = mockRequest({});
      expect(getMobileSchemeCookie(req)).toBeUndefined();
    });
  });

  describe("isValidMobileScheme", () => {
    it("accepts the allowed 'dofek' scheme", () => {
      expect(isValidMobileScheme("dofek")).toBe(true);
    });

    it("rejects arbitrary strings", () => {
      expect(isValidMobileScheme("https://evil.com")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidMobileScheme("")).toBe(false);
    });

    it("rejects non-string values", () => {
      expect(isValidMobileScheme(undefined)).toBe(false);
      expect(isValidMobileScheme(null)).toBe(false);
      expect(isValidMobileScheme(123)).toBe(false);
    });
  });
});
