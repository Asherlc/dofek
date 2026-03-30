import { describe, expect, it, vi } from "vitest";
import { isAdmin } from "./admin.ts";

function createMockDb(rows: Array<Record<string, unknown>>) {
  return { execute: vi.fn().mockResolvedValue(rows) };
}

describe("isAdmin", () => {
  it("returns true when user has is_admin set to true", async () => {
    const db = createMockDb([{ is_admin: true }]);
    expect(await isAdmin(db, "user-1")).toBe(true);
  });

  it("returns false when user has is_admin set to false", async () => {
    const db = createMockDb([{ is_admin: false }]);
    expect(await isAdmin(db, "user-1")).toBe(false);
  });

  it("returns false when user is not found", async () => {
    const db = createMockDb([]);
    expect(await isAdmin(db, "nonexistent")).toBe(false);
  });

  it("queries the correct user", async () => {
    const db = createMockDb([{ is_admin: true }]);
    await isAdmin(db, "user-123");
    expect(db.execute).toHaveBeenCalledOnce();
  });
});
