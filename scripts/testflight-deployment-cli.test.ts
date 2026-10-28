import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordTestFlightUpload, requiresTestFlightUpload } from "./testflight-deployment.ts";

vi.mock("./testflight-deployment.ts", () => ({
  recordTestFlightUpload: vi.fn(),
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

  it("records the confirmed upload's actual source, build number and caller run URL", async () => {
    await run(["record", "owner/dofek", sha, "1793210000", runUrl]);
    expect(recordTestFlightUpload).toHaveBeenCalledExactlyOnceWith(
      "owner/dofek",
      sha,
      "1793210000",
      runUrl,
    );
    expect(requiresTestFlightUpload).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each([
    [],
    ["unknown", "owner/dofek", sha],
    ["detect"],
    ["detect", "owner/dofek"],
    ["detect", "owner/dofek", sha, "unexpected"],
    ["detect", "owner/dofek", sha, "--force", "unexpected"],
    ["record"],
    ["record", "owner/dofek"],
    ["record", "owner/dofek", sha],
    ["record", "owner/dofek", sha, "1793210000"],
    ["record", "owner/dofek", sha, "1793210000", runUrl, "unexpected"],
  ])("rejects incomplete or unsupported arguments %j", async (...arguments_) => {
    await expect(run(arguments_)).rejects.toThrow("Usage:");
    expect(recordTestFlightUpload).not.toHaveBeenCalled();
    expect(requiresTestFlightUpload).not.toHaveBeenCalled();
  });
});
