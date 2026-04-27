import { describe, expect, it, vi } from "vitest";
import { getAccessWindowForUser } from "./access-window-repository.ts";

describe("getAccessWindowForUser", () => {
  it("derives limited access from user profile and billing state", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          created_at: "2026-04-10T18:30:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
        },
      ]),
    };

    await expect(getAccessWindowForUser(db, "user-1")).resolves.toEqual({
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-04-10",
      endDateExclusive: "2026-04-17",
    });
  });

  it("throws when the authenticated user profile is missing", async () => {
    const db = { execute: vi.fn(async () => []) };

    await expect(getAccessWindowForUser(db, "missing-user")).rejects.toThrow(
      "Authenticated user profile not found",
    );
  });
});
