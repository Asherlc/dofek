import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMutantKitExecutable } from "./swift-mutation-tool.ts";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("node:crypto", () => ({ createHash: vi.fn() }));
const actualCreateHash = (await vi.importActual<typeof import("node:crypto")>("node:crypto"))
  .createHash;
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal(
    "process",
    Object.create(process, { platform: { value: "darwin" }, arch: { value: "arm64" } }),
  );
  vi.mocked(readFileSync).mockReturnValue(Buffer.from("binary"));
  const hasher = actualCreateHash("sha256");
  const digest = vi
    .spyOn(hasher, "digest")
    .mockReturnValue("b838653c3eb201e012127d945a236dddfd991c6f034eab69aca792d77ba08be3");
  vi.mocked(createHash).mockReturnValue(hasher);
  const execute = vi.fn((command: string, _args: string[]): string =>
    command === "mise"
      ? "/installed/mutantkit\n"
      : "mutantkit 1.3.2\ncommit: 1e345263e36e1658adeed6ae919b7f5875a2601b\nswift-syntax: 604.0.0\nplan schema: 1\nreport schema: 2\n",
  );
  return { digest, execute };
}
describe("canonical MutantKit executable identity", () => {
  it("executes the same mise-resolved binary that passed its digest check", () => {
    const { execute } = setup();
    expect(getMutantKitExecutable(execute)).toBe("/installed/mutantkit/mutantkit");
    expect(execute).toHaveBeenCalledWith("mise", ["where", "github:juntaki/mutantkit@1.3.2"]);
    expect(execute).toHaveBeenCalledWith("/installed/mutantkit/mutantkit", ["--version"]);
  });
  it("rejects an executable digest mismatch before execution", () => {
    const { execute, digest } = setup();
    digest.mockReturnValue("wrong");
    expect(() => getMutantKitExecutable(execute)).toThrow(/checksum/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(["1.3.1", "wrong commit", "report schema: 1"])(
    "rejects unsupported identity %s",
    (identity) => {
      const { execute } = setup();
      execute.mockReturnValueOnce("/installed/mutantkit\n").mockReturnValueOnce(identity);
      expect(() => getMutantKitExecutable(execute)).toThrow(/identity/i);
    },
  );
  it("propagates canonical installation command failures", () => {
    const { execute } = setup();
    execute.mockImplementationOnce(() => {
      throw new Error("mise: not installed");
    });
    expect(() => getMutantKitExecutable(execute)).toThrow(/mise.*not installed/i);
  });
  it("rejects an unsupported host before resolving or executing a tool", () => {
    const { execute } = setup();
    vi.stubGlobal("process", Object.create(process, { platform: { value: "linux" } }));
    expect(() => getMutantKitExecutable(execute)).toThrow(/macOS arm64/);
    expect(execute).not.toHaveBeenCalled();
  });
});
