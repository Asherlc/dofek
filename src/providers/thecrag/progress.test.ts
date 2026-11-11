import { describe, expect, it } from "vitest";
import { createMockDatabase } from "../test-helpers.ts";
import { TheCragSyncProgress } from "./progress.ts";

const identity = { accountId: "123", authorizationId: "f3b53a3d-5b67-4215-8342-35a566b4c6a0" };
describe("theCrag incremental progress", () => {
  it("loads only the cursor belonging to the current connection and account", async () => {
    const { db } = createMockDatabase({
      tokensResult: [{ value: { ...identity, epoch: 1791676800 } }],
    });
    expect(await new TheCragSyncProgress(db, "user", identity).load()).toBe(1791676800);
    expect(
      await new TheCragSyncProgress(db, "user", { ...identity, accountId: "456" }).load(),
    ).toBeUndefined();
    expect(
      await new TheCragSyncProgress(db, "user", { ...identity, authorizationId: "other" }).load(),
    ).toBeUndefined();
  });
  it("starts without a cursor when no state exists", async () => {
    expect(
      await new TheCragSyncProgress(createMockDatabase().db, "user", identity).load(),
    ).toBeUndefined();
  });
  it("fails explicitly on corrupt stored progress", async () => {
    const { db } = createMockDatabase({ tokensResult: [{ value: { epoch: "bad" } }] });
    await expect(new TheCragSyncProgress(db, "user", identity).load()).rejects.toThrow(/progress/);
  });
  it("saves operational state under the scoped user", async () => {
    const { db, spies } = createMockDatabase();
    await new TheCragSyncProgress(db, "user", identity).save(1791676800);
    expect(spies.values).toHaveBeenCalledWith({
      userId: "user",
      key: "thecrag_sync_cursor",
      value: { ...identity, epoch: 1791676800 },
    });
    expect(spies.onConflictDoUpdate).toHaveBeenCalled();
  });
});
