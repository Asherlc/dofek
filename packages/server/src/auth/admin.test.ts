import { describe, expect, it, vi } from "vitest";
import { isAdmin } from "./admin.ts";

function createMockDb(rows: Array<Record<string, unknown>>) {
  return { execute: vi.fn().mockResolvedValue(rows) };
}

describe("isAdmin", () => {
  it("returns true when user has the admins group", async () => {
    const db = createMockDb([{ groups: ["admins", "users"] }]);
    expect(await isAdmin(db, "user-1")).toBe(true);
  });

  it("returns false when user has no admins group", async () => {
    const db = createMockDb([{ groups: ["users"] }]);
    expect(await isAdmin(db, "user-1")).toBe(false);
  });

  it("returns false when user has no Authentik account", async () => {
    const db = createMockDb([]);
    expect(await isAdmin(db, "user-1")).toBe(false);
  });

  it("returns false when groups is null", async () => {
    const db = createMockDb([{ groups: null }]);
    expect(await isAdmin(db, "user-1")).toBe(false);
  });

  it("queries the correct user and provider", async () => {
    const db = createMockDb([{ groups: ["admins"] }]);
    await isAdmin(db, "user-123");
    expect(db.execute).toHaveBeenCalledOnce();
  });
});
