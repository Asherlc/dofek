import { describe, expect, it, vi } from "vitest";
import {
  clearOAuthFlowCookies,
  clearSessionCookie,
  getOAuthFlowCookies,
  getSessionCookie,
  setOAuthFlowCookies,
  setSessionCookie,
} from "../cookies.ts";

/** Create a mock Express Request with optional cookies */
function mockRequest(cookies: Record<string, string> = {}) {
  return { cookies } as unknown as import("express").Request;
}

/** Create a mock Express Response that tracks cookie operations */
function mockResponse() {
  const res = {
    cookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
  };
  return res as unknown as import("express").Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
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
      const req = { cookies: undefined } as unknown as import("express").Request;
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
    it("clears state, code_verifier, and link_user cookies", () => {
      const res = mockResponse();

      clearOAuthFlowCookies(res);

      expect(res.clearCookie).toHaveBeenCalledTimes(3);
      expect(res.clearCookie).toHaveBeenCalledWith("auth_state", { path: "/" });
      expect(res.clearCookie).toHaveBeenCalledWith("auth_code_verifier", {
        path: "/",
      });
      expect(res.clearCookie).toHaveBeenCalledWith("auth_link_user", {
        path: "/",
      });
    });
  });
});
