import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareTestFlightUpload,
  recordTestFlightUpload,
  requiresTestFlightUpload,
} from "./testflight-deployment.ts";

vi.mock("./testflight-deployment.ts", () => ({
  recordTestFlightUpload: vi.fn(),
  prepareTestFlightUpload: vi.fn(),
  requiresTestFlightUpload: vi.fn(),
}));

const originalArguments = process.argv;
const sha = "a".repeat(40);
const runUrl = "https://github.com/owner/dofek/actions/runs/123";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.mocked(requiresTestFlightUpload).mockReturnValue(true);
  vi.mocked(prepareTestFlightUpload).mockReturnValue(5);
});

afterEach(() => {
  process.argv = originalArguments;
  vi.restoreAllMocks();
});

function run(arguments_: string[]) {
  process.argv = ["node", "testflight-deployment-cli.ts", ...arguments_];
  return import("./testflight-deployment-cli.ts");
}

describe("TestFlight deployment command", () => {
  it.each([true, false])("prints only the automatic detection decision %s", async (decision) => {
    vi.mocked(requiresTestFlightUpload).mockReturnValue(decision);
    await run(["detect", "owner/dofek", sha]);
    expect(requiresTestFlightUpload).toHaveBeenCalledExactlyOnceWith("owner/dofek", sha, false);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(decision);
    expect(recordTestFlightUpload).not.toHaveBeenCalled();
  });

  it("passes explicit manual publication intent without replacing the deployed source SHA", async () => {
    await run(["detect", "owner/dofek", sha, "--force"]);
    expect(requiresTestFlightUpload).toHaveBeenCalledExactlyOnceWith("owner/dofek", sha, true);
  });

  it.each([5, 51])("records the original deployment %s and upload evidence", async (id) => {
    await run(["record", "owner/dofek", String(id), sha, "1793210000", runUrl]);
    expect(recordTestFlightUpload).toHaveBeenCalledExactlyOnceWith(
      "owner/dofek",
      id,
      sha,
      "1793210000",
      runUrl,
    );
    expect(requiresTestFlightUpload).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("prints the deployment ID prepared for this upload attempt", async () => {
    await run(["prepare", "owner/dofek", sha, "1793210000", runUrl]);
    expect(prepareTestFlightUpload).toHaveBeenCalledExactlyOnceWith(
      "owner/dofek",
      sha,
      "1793210000",
      runUrl,
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith(5);
    expect(recordTestFlightUpload).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ["unknown", "owner/dofek", sha],
    ["unknown", "owner/dofek", "5", sha, "1793210000", runUrl],
    ["record", "", "5", sha, "1793210000", runUrl],
    ["record", "owner/dofek", "id5", sha, "1793210000", runUrl],
    ["record", "owner/dofek", "5x", sha, "1793210000", runUrl],
    ["detect"],
    ["detect", "owner/dofek"],
    ["detect", "owner/dofek", sha, "unexpected"],
    ["detect", "owner/dofek", sha, "--force", "unexpected"],
    ["record"],
    ["record", "owner/dofek"],
    ["record", "owner/dofek", sha],
    ["record", "owner/dofek", sha, "1793210000"],
    ["record", "owner/dofek", sha, "1793210000", runUrl, "unexpected"],
    ["record", "owner/dofek", "5", sha, "1793210000", runUrl, "unexpected"],
    ["prepare"],
    ["prepare", "owner/dofek"],
    ["prepare", "owner/dofek", sha],
    ["prepare", "owner/dofek", sha, "1793210000"],
    ["prepare", "owner/dofek", sha, "1793210000", runUrl, "unexpected"],
  ])("rejects incomplete or unsupported arguments %j", async (...arguments_) => {
    await expect(run(arguments_)).rejects.toThrow("Usage:");
    expect(recordTestFlightUpload).not.toHaveBeenCalled();
    expect(prepareTestFlightUpload).not.toHaveBeenCalled();
    expect(requiresTestFlightUpload).not.toHaveBeenCalled();
  });
});
