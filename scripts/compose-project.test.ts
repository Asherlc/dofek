import { describe, expect, it } from "vitest";
import { resolveComposeProjectIdentity } from "./compose-project.ts";

describe("resolveComposeProjectIdentity", () => {
  it("derives the default project name and environment path", () => {
    expect(resolveComposeProjectIdentity("/worktrees/dazzling-newt", [])).toEqual({
      composeEnvironmentPath: "/worktrees/dazzling-newt/.env.local",
      composeProjectName: "dazzling-newt",
      projectSuffix: null,
    });
  });

  it("derives one validated suffixed project identity", () => {
    expect(
      resolveComposeProjectIdentity("/worktrees/dazzling-newt", [
        "--project-suffix",
        "peerdb-integration",
      ]),
    ).toEqual({
      composeEnvironmentPath: "/worktrees/dazzling-newt/.env.peerdb-integration.local",
      composeProjectName: "dazzling-newt-peerdb-integration",
      projectSuffix: "peerdb-integration",
    });
  });

  it.each([
    [["--project-suffix"], "requires a lowercase alphanumeric"],
    [["--project-suffix", "INVALID"], "requires a lowercase alphanumeric"],
    [["--project-suffix", "one", "--project-suffix", "two"], "can only be specified once"],
  ])("rejects invalid suffix arguments", (arguments_, message) => {
    expect(() => resolveComposeProjectIdentity("/worktrees/dazzling-newt", arguments_)).toThrow(
      message,
    );
  });
});
