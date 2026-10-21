import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisClient = vi.hoisted(() => ({
  set: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("bullmq", () => ({
  RedisConnection: vi.fn(() => ({ client: Promise.resolve(redisClient) })),
}));

vi.mock("dofek/jobs/queues", () => ({
  getRedisConnection: vi.fn(),
}));

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

vi.mock("dofek/lib/cache", () => ({
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
import { ensureProvider, saveTokens } from "dofek/db/tokens";
import { queryCache } from "dofek/lib/cache";
import type { SyncProvider } from "dofek/providers/types";
import { createMockDatabase } from "../../../../../src/providers/test-helpers.ts";
import {
  InMemoryMobileAuthExchangeStore,
  RedisMobileAuthExchangeStore,
} from "../../lib/mobile-auth-exchange-store.ts";
import { InMemoryPendingEmailSignupStore } from "../../lib/pending-email-signup-store.ts";
import {
  getMobileAuthExchangeStoreRef,
  getPendingEmailSignupStoreRef,
  initAuthStores,
  isSafeRelativeRedirect,
  persistProviderConnection,
  sanitizeReturnTo,
  storeIdentityFlow,
} from "./shared.ts";

describe("shared auth helpers", () => {
  describe("persistProviderConnection", () => {
    it("checks provider ownership inside the token transaction before creating a connection", async () => {
      const { db } = createMockDatabase();
      const events: string[] = [];
      const assertCanConnect = vi.fn(async () => {
        events.push("assert-owner");
      });
      vi.mocked(ensureProvider).mockImplementationOnce(async () => {
        events.push("ensure-provider");
        return "test";
      });
      vi.mocked(saveTokens).mockImplementationOnce(async () => {
        events.push("save-tokens");
      });
      const provider: SyncProvider = {
        id: "test",
        name: "Test",
        validate: () => null,
        sync: async () => ({ provider: "test", recordsSynced: 0, errors: [], duration: 0 }),
        authSetup: () => ({ assertCanConnect }),
      };
      const tokens = {
        accessToken: "access",
        refreshToken: null,
        scopes: null,
        expiresAt: new Date("2099-01-01"),
      };
      await persistProviderConnection({
        db,
        provider,
        providerName: "Test",
        tokens,
        userId: "owner",
      });
      expect(events).toEqual(["assert-owner", "ensure-provider", "save-tokens"]);
      expect(assertCanConnect).toHaveBeenCalledWith(
        expect.objectContaining({ transaction: expect.any(Function) }),
        "owner",
        tokens,
      );
    });

    it("does not create a connection or save tokens after the ownership guard rejects", async () => {
      vi.mocked(ensureProvider).mockClear();
      vi.mocked(saveTokens).mockClear();
      vi.mocked(queryCache.invalidateByPrefix).mockClear();
      const { db } = createMockDatabase();
      const provider: SyncProvider = {
        id: "test",
        name: "Test",
        validate: () => null,
        sync: async () => ({ provider: "test", recordsSynced: 0, errors: [], duration: 0 }),
        authSetup: () => ({
          assertCanConnect: async () => {
            throw new Error("Account already owned");
          },
        }),
      };
      await expect(
        persistProviderConnection({
          db,
          provider,
          providerName: "Test",
          userId: "owner",
          tokens: {
            accessToken: "access",
            refreshToken: null,
            scopes: null,
            expiresAt: new Date("2099-01-01"),
          },
        }),
      ).rejects.toThrow("Account already owned");
      expect(ensureProvider).not.toHaveBeenCalled();
      expect(saveTokens).not.toHaveBeenCalled();
      expect(queryCache.invalidateByPrefix).not.toHaveBeenCalled();
    });
  });
  describe("sanitizeReturnTo", () => {
    it("returns undefined for falsy input", () => {
      expect(sanitizeReturnTo(undefined)).toBeUndefined();
      expect(sanitizeReturnTo("")).toBeUndefined();
    });

    it("rejects paths that don't start with /", () => {
      expect(sanitizeReturnTo("dashboard")).toBeUndefined();
      expect(sanitizeReturnTo("https://evil.com")).toBeUndefined();
      expect(sanitizeReturnTo("javascript:alert(1)")).toBeUndefined();
    });

    it("rejects protocol-relative URLs (//)", () => {
      expect(sanitizeReturnTo("//evil.com")).toBeUndefined();
    });

    it("accepts valid relative paths", () => {
      expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
      expect(sanitizeReturnTo("/settings/profile")).toBe("/settings/profile");
      expect(sanitizeReturnTo("/?newUser=true")).toBe("/?newUser=true");
    });
  });

  describe("isSafeRelativeRedirect", () => {
    it("accepts same-origin relative paths", () => {
      expect(isSafeRelativeRedirect("/dashboard")).toBe(true);
      expect(isSafeRelativeRedirect("/?newUser=true")).toBe(true);
    });

    it("rejects external and protocol-relative URLs", () => {
      expect(isSafeRelativeRedirect("dashboard")).toBe(false);
      expect(isSafeRelativeRedirect("https://evil.com")).toBe(false);
      expect(isSafeRelativeRedirect("//evil.com")).toBe(false);
      expect(isSafeRelativeRedirect("javascript:alert(1)")).toBe(false);
    });
  });

  describe("initAuthStores pending email signup store", () => {
    it("uses the in-memory pending signup store in tests", () => {
      initAuthStores(createDatabaseFromEnv());

      expect(getPendingEmailSignupStoreRef()).toBeInstanceOf(InMemoryPendingEmailSignupStore);
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

  describe("initAuthStores mobile exchange store", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it("uses the in-memory exchange store in tests", () => {
      process.env.NODE_ENV = "test";

      initAuthStores(createDatabaseFromEnv());

      expect(getMobileAuthExchangeStoreRef()).toBeInstanceOf(InMemoryMobileAuthExchangeStore);
    });

    it("uses the Redis exchange store outside tests", () => {
      process.env.NODE_ENV = "production";

      initAuthStores(createDatabaseFromEnv());

      expect(getMobileAuthExchangeStoreRef()).toBeInstanceOf(RedisMobileAuthExchangeStore);
    });
  });
});
