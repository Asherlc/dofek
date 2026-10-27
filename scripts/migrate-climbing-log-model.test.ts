import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "./migrate-climbing-log-model.ts";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  inspect: vi.fn(),
  convert: vi.fn(),
  validate: vi.fn(),
  migrate: vi.fn(),
  end: vi.fn(),
}));
vi.mock("../src/db/index.ts", () => ({
  createDatabaseFromEnv: () => ({ $client: { end: mocks.end } }),
}));
vi.mock("../src/db/climbing-log-model-conversion.ts", () => ({
  climbingLogModelState: mocks.state,
  inspectClimbingLogConversion: mocks.inspect,
  convertClimbingLogBatch: mocks.convert,
  validateClimbingLogConversion: mocks.validate,
}));
vi.mock("../src/db/migrate.ts", () => ({ runMigrations: mocks.migrate }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://test.invalid/health");
  mocks.state.mockResolvedValue({ legacy: true, prepared: true, finalized: false });
  mocks.inspect.mockResolvedValue({ inspected: 1, conflicts: [] });
  mocks.validate.mockResolvedValue({ inspected: 1, conflicts: [] });
  mocks.end.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("rejects unknown commands and invalid batch sizes before touching the database", async () => {
  for (const args of [
    ["bad"],
    ["convert", "--batch-size", "0"],
    ["convert", "--batch-size", "1.5"],
    ["inspect", "extra"],
  ])
    await expect(main(args)).rejects.toThrow();
  expect(mocks.state).not.toHaveBeenCalled();
});
it("runs read-only inspection without preparing a migration", async () => {
  await main(["inspect"]);
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(mocks.migrate).not.toHaveBeenCalled();
  expect(mocks.end).toHaveBeenCalledOnce();
});
it("finishes bounded conversion batches and refuses unresolved finalization conflicts", async () => {
  mocks.convert
    .mockResolvedValueOnce({ converted: 2, remaining: 1 })
    .mockResolvedValueOnce({ converted: 1, remaining: 0 });
  await main(["convert", "--batch-size", "2"]);
  expect(mocks.convert).toHaveBeenCalledTimes(2);
  expect(mocks.convert).toHaveBeenCalledWith(expect.anything(), 2);
  mocks.validate.mockResolvedValueOnce({
    inspected: 1,
    conflicts: [{ field: "attemptGraph", message: "Invalid parent" }],
  });
  await expect(main(["finalize"])).rejects.toThrow("conflicts");
  expect(mocks.migrate).not.toHaveBeenCalled();
});
it("detects an already-finalized schema before considering an earlier preparation prefix", async () => {
  mocks.state.mockResolvedValue({ legacy: false, prepared: false, finalized: true });
  await main(["prepare"]);
  expect(mocks.migrate).not.toHaveBeenCalled();
  expect(mocks.end).toHaveBeenCalledOnce();
});
