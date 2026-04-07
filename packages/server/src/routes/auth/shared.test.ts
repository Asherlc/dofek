import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal mocks for shared.ts dependencies
vi.mock("../../lib/oauth-state-store.ts", () => ({
  getOAuthStateStore: vi.fn(() => ({
    save: vi.fn(),
    get: vi.fn(),
    has: vi.fn(),
    delete: vi.fn(),
  })),
  getOAuth1SecretStore: vi.fn(() => ({
    save: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  })),
}));

const mockIdentityFlowStore = {
  save: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};
vi.mock("../../lib/identity-flow-store.ts", () => ({
  getIdentityFlowStore: vi.fn(() => mockIdentityFlowStore),
}));

vi.mock("../../lib/cache.ts", () => ({
  queryCache: { invalidateByPrefix: vi.fn() },
}));

vi.mock("../../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock("dofek/db/tokens", () => ({
  ensureProvider: vi.fn(() => Promise.resolve()),
  saveTokens: vi.fn(() => Promise.resolve()),
}));

vi.mock("dofek/providers/types", () => ({
  isWebhookProvider: vi.fn(() => false),
}));

vi.mock("../webhooks.ts", () => ({
  registerWebhookForProvider: vi.fn(() => Promise.resolve()),
}));

import { createDatabaseFromEnv } from "dofek/db";
import {
  deletePendingEmailSignup,
  getPendingEmailSignup,
  initAuthStores,
  type PendingEmailSignupEntry,
  sanitizeReturnTo,
  storeIdentityFlow,
  storePendingEmailSignup,
} from "./shared.ts";

describe("shared auth helpers", () => {
  describe("sanitizeReturnTo", () => {
    it("returns undefined for falsy input", () => {
      expect(sanitizeReturnTo(undefined)).toBeUndefined();
      expect(sanitizeReturnTo("")).toBeUndefined();
    });

    it("rejects paths that don't start with /", () => {
      expect(sanitizeReturnTo("https://evil.com")).toBeUndefined();
      expect(sanitizeReturnTo("javascript:alert(1)")).toBeUndefined();
    });

    it("rejects protocol-relative URLs (//)", () => {
      expect(sanitizeReturnTo("//evil.com")).toBeUndefined();
    });

    it("accepts valid relative paths", () => {
      expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
      expect(sanitizeReturnTo("/settings/profile")).toBe("/settings/profile");
    });
  });

  describe("storePendingEmailSignup / getPendingEmailSignup / deletePendingEmailSignup", () => {
    const entry: PendingEmailSignupEntry = {
      providerId: "strava",
      providerName: "Strava",
      identity: {
        providerAccountId: "123",
        email: null,
        name: "Test User",
      },
      tokens: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date("2027-01-01"),
        scopes: "read",
      },
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("stores and retrieves a pending signup", () => {
      const token = storePendingEmailSignup(entry);
      expect(token).toBeTruthy();
      expect(getPendingEmailSignup(token)).toBe(entry);
    });

    it("deletes a pending signup", () => {
      const token = storePendingEmailSignup(entry);
      deletePendingEmailSignup(token);
      expect(getPendingEmailSignup(token)).toBeUndefined();
    });

    it("returns undefined for unknown token", () => {
      expect(getPendingEmailSignup("nonexistent")).toBeUndefined();
    });

    it("expires after 10 minutes", () => {
      const token = storePendingEmailSignup(entry);
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      expect(getPendingEmailSignup(token)).toBeUndefined();
    });
  });

  describe("storeIdentityFlow", () => {
    beforeEach(() => {
      initAuthStores(createDatabaseFromEnv());
    });

    it("propagates errors from the identity flow store", async () => {
      mockIdentityFlowStore.save.mockRejectedValueOnce(new Error("Redis connection refused"));

      await expect(
        storeIdentityFlow("apple:state-123", { codeVerifier: "verifier" }),
      ).rejects.toThrow("Redis connection refused");
    });

    it("succeeds when the store saves successfully", async () => {
      mockIdentityFlowStore.save.mockResolvedValueOnce(undefined);

      await expect(
        storeIdentityFlow("apple:state-456", { codeVerifier: "verifier" }),
      ).resolves.toBeUndefined();
    });
  });
});
