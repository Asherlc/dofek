import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./view-sync-planner.ts", () => ({
  planMaterializedViewSync: vi.fn(),
}));

import { main } from "./run-view-sync-planner.ts";
import { planMaterializedViewSync } from "./view-sync-planner.ts";

const mockPlanMaterializedViewSync = vi.mocked(planMaterializedViewSync);

describe("run-view-sync-planner main()", () => {
  const originalUrl = process.env.DATABASE_URL;
  const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  beforeEach(() => {
    mockPlanMaterializedViewSync.mockReset();
    stdoutWriteSpy.mockClear();
  });

  afterEach(() => {
    if (originalUrl) {
      process.env.DATABASE_URL = originalUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("throws when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;

    await expect(main()).rejects.toThrow("DATABASE_URL");
  });

  it("prints workflow-friendly outputs", async () => {
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    mockPlanMaterializedViewSync.mockResolvedValue({
      required: true,
      reasons: ["view_definition_changed:fitness.v_test"],
    });

    await main();

    expect(mockPlanMaterializedViewSync).toHaveBeenCalledWith(
      "postgres://test:test@localhost:5432/test",
    );
    expect(stdoutWriteSpy).toHaveBeenNthCalledWith(1, "required=true\n");
    expect(stdoutWriteSpy).toHaveBeenNthCalledWith(
      2,
      "reasons=view_definition_changed:fitness.v_test\n",
    );
  });
});
