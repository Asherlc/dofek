// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAccountErasurePreparation,
  clearAccountErasureStatusCapability,
  loadAccountErasurePreparation,
  loadAccountErasureStatusCapability,
  markAccountErasureConfirmationAttempted,
  saveAccountErasurePreparation,
  saveAccountErasureStatusCapability,
} from "./account-erasure-storage.ts";

describe("web account-erasure capability storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores a preparation only for the account that created it", () => {
    saveAccountErasurePreparation({
      ownerUserId: "user-1",
      preparationToken: "p".repeat(43),
      expiresAt: "2026-07-26T12:15:00.000Z",
    });

    expect(loadAccountErasurePreparation("user-1")?.preparationToken).toBe("p".repeat(43));
    expect(loadAccountErasurePreparation("user-2")).toBeNull();
  });

  it("stores the public status capability independently of the authenticated session", () => {
    saveAccountErasureStatusCapability({
      cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    clearAccountErasurePreparation();

    expect(loadAccountErasureStatusCapability()).toEqual({
      cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
  });

  it("durably marks the irreversible request before sending it", () => {
    saveAccountErasurePreparation({
      ownerUserId: "user-1",
      preparationToken: "p".repeat(43),
      expiresAt: "2026-07-26T12:15:00.000Z",
    });

    markAccountErasureConfirmationAttempted(
      "22222222-2222-4222-8222-222222222222",
      "2026-07-26T12:05:00.000Z",
    );

    const persisted = localStorage.getItem("dofek:account-erasure:preparation:v1");
    expect(persisted).toContain("confirmationAttemptedAt");
    expect(persisted).toContain("22222222-2222-4222-8222-222222222222");
    expect(persisted).not.toContain("user-1");
    expect(loadAccountErasurePreparation("user-1")).toBeNull();
  });

  it("discards malformed local values at the runtime boundary", () => {
    localStorage.setItem("dofek:account-erasure:status:v1", '{"statusToken":7}');

    expect(loadAccountErasureStatusCapability()).toBeNull();
    expect(localStorage.getItem("dofek:account-erasure:status:v1")).toBeNull();
  });

  it("treats unavailable browser storage as an empty capability", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      removeItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => {
        throw new Error("storage unavailable");
      },
    } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;

    expect(loadAccountErasureStatusCapability(storage)).toBeNull();
    expect(() =>
      saveAccountErasureStatusCapability(
        {
          cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
          requestId: "11111111-1111-4111-8111-111111111111",
          statusToken: "s".repeat(43),
        },
        storage,
      ),
    ).toThrow("Account erasure browser storage write failed.");
  });

  it("reports and removes malformed values when cleanup storage also fails", () => {
    const storage = {
      getItem: () => "not-json",
      removeItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => undefined,
    } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;

    expect(loadAccountErasureStatusCapability(storage)).toBeNull();
  });

  it("rejects confirmation attempts without a saved preparation", () => {
    expect(() =>
      markAccountErasureConfirmationAttempted(
        "22222222-2222-4222-8222-222222222222",
        "2026-07-26T12:05:00.000Z",
      ),
    ).toThrow("saved account deletion preparation is unavailable");
  });

  it("reports failures while clearing or saving preparation capabilities", () => {
    const removeFailureStorage = {
      getItem: () => null,
      removeItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => undefined,
    } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;
    expect(() => clearAccountErasurePreparation(removeFailureStorage)).not.toThrow();

    const writeFailureStorage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;
    expect(() =>
      saveAccountErasurePreparation(
        {
          ownerUserId: "user-1",
          preparationToken: "p".repeat(43),
          expiresAt: "2026-07-26T12:15:00.000Z",
        },
        writeFailureStorage,
      ),
    ).toThrow("Account erasure browser storage write failed.");
  });

  it("silently tolerates status capability removal failure", () => {
    const storage = {
      getItem: () => null,
      removeItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => undefined,
    } satisfies Pick<Storage, "getItem" | "removeItem" | "setItem">;

    expect(() => clearAccountErasureStatusCapability(storage)).not.toThrow();
  });
});
