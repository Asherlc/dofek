import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import {
  prepareTestFlightUpload,
  recordTestFlightUpload,
  requiresTestFlightUpload,
} from "./testflight-deployment.ts";

const gh = vi.mocked(execFileSync);
const { execFileSync: realExecute } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");
const currentSha = "a".repeat(40);
const earlierSha = "b".repeat(40);
const runUrl = "https://github.com/owner/dofek/actions/runs/123";
const receipt = (sha: string, state: string | null = "SUCCESS", task = "testflight-upload") => ({
  databaseId: 5,
  commitOid: sha,
  environment: "testflight",
  task,
  latestStatus: state === null ? null : { state },
});
const page = (nodes: unknown[] = [], hasNextPage = false, endCursor: string | null = null) =>
  JSON.stringify({
    data: { repository: { deployments: { nodes, pageInfo: { hasNextPage, endCursor } } } },
  });

const uploadDeployment = (patch: Record<string, unknown> = {}) => ({
  id: 5,
  node_id: "D_returned_fixture_node",
  sha: currentSha,
  environment: "testflight",
  task: "testflight-upload",
  payload: { build_number: "1793210000", run_url: runUrl },
  ...patch,
});
const deploymentStatus = (state: string | null, databaseId = 5) =>
  JSON.stringify({
    data: { node: { databaseId, latestStatus: state === null ? null : { state } } },
  });

beforeEach(() => gh.mockReset());

describe("TestFlight upload receipts", () => {
  it("normalizes uppercase requested and recorded commit SHAs before comparing or publishing", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(page([receipt(currentSha.toUpperCase())]));
    expect(requiresTestFlightUpload("owner/dofek", currentSha.toUpperCase())).toBe(false);
    expect(gh).toHaveBeenNthCalledWith(1, "git", ["cat-file", "-e", `${currentSha}^{commit}`], {
      stdio: "inherit",
    });
    gh.mockReturnValueOnce(page())
      .mockReturnValueOnce(JSON.stringify(uploadDeployment({ sha: currentSha.toUpperCase() })))
      .mockReturnValueOnce('{"state":"pending"}');
    prepareTestFlightUpload("owner/dofek", currentSha.toUpperCase(), "1793210000", runUrl);
    expect(gh).toHaveBeenNthCalledWith(
      4,
      "gh",
      expect.any(Array),
      expect.objectContaining({
        input: expect.stringContaining(`"ref":"${currentSha}"`),
      }),
    );
  });

  it.each([`${currentSha}f`, `f${currentSha}`, `g${currentSha.slice(1)}`])(
    "rejects malformed SHA %s before accessing Git or deployment metadata",
    (sha) => {
      expect(() => requiresTestFlightUpload("owner/dofek", sha, true)).toThrow();
      expect(() => recordTestFlightUpload("owner/dofek", 5, sha, "1793210000", runUrl)).toThrow();
      expect(gh).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      path: "packages/mobile/modules/example/ios/Code.swift",
      destination: "notes/Code.swift",
      native: true,
    },
    { path: "packages/mobile/assets/é.png", destination: null, native: true },
    { path: "packages/mobile/assets/line\nbreak.png", destination: null, native: true },
    { path: "notes/line\npackages/mobile/assets/icon.png", destination: null, native: false },
  ])("detects real Git tree changes for $path", ({ path, destination, native }) => {
    const directory = mkdtempSync(join(tmpdir(), "testflight-paths-"));
    const git = (arguments_: string[]) =>
      realExecute("git", arguments_, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = () => {
      git(["add", "--all"]);
      git([
        "-c",
        "user.name=Deploy Test",
        "-c",
        "user.email=deploy@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    try {
      git(["init", "--initial-branch=main"]);
      git(["config", "diff.renames", "true"]);
      git(["config", "core.quotePath", "true"]);
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), "original contents\n");
      const baseline = commit();
      if (destination) {
        mkdirSync(dirname(join(directory, destination)), { recursive: true });
        renameSync(join(directory, path), join(directory, destination));
      } else writeFileSync(join(directory, path), "updated contents\n");
      const target = commit();
      gh.mockImplementation((command, arguments_, options) => {
        if (command === "git")
          return realExecute(command, arguments_ ?? [], { ...options, cwd: directory });
        return page([receipt(baseline)]);
      });
      expect(requiresTestFlightUpload("owner/dofek", target)).toBe(native);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors an explicit manual native publication after validating the exact source commit", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(page([receipt(currentSha)]));
    expect(requiresTestFlightUpload("owner/dofek", currentSha, true)).toBe(true);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("builds when successful upload history is genuinely empty", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(page());
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(true);
  });

  it.each([
    { path: "packages/mobile/modules/whoop-ble/ios/Connection.swift", native: true },
    { path: "pnpm-lock.yaml", native: true },
    { path: "packages/mobile/package.json", native: true },
    { path: "packages/mobile/app.json", native: true },
    { path: "packages/mobile/app.config.js", native: true },
    { path: "packages/mobile/plugins/with-podfile-post-install.js", native: true },
    { path: "packages/mobile/build/ExportOptions.plist", native: true },
    { path: "packages/mobile/targets/DofekWatch/Package.swift", native: true },
    { path: "packages/mobile/native/SomeNativeInput.swift", native: true },
    { path: "packages/mobile/modules/health-kit/expo-module.config.json", native: true },
    { path: "packages/mobile/modules/health-kit/ios/HealthKitModule.swift", native: true },
    { path: "packages/mobile/app/settings.tsx", native: false },
    { path: "packages/mobile/components/MetricCard.tsx", native: false },
    { path: "packages/mobile/modules/health-kit/src/HealthKitModule.ts", native: false },
    { path: "packages/format/package.json", native: false },
    { path: "packages/mobile/lib/telemetry.ts", native: false },
    { path: "packages/mobile/README.md", native: false },
  ])("classifies $path against the actual uploaded source tree", ({ path, native }) => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(page([receipt(earlierSha)]))
      .mockReturnValueOnce(`${path}\0`);

    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(native);
    expect(gh).toHaveBeenLastCalledWith(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", earlierSha, currentSha, "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  });

  it("skips an exact source commit already uploaded successfully", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(page([receipt(currentSha)]));
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown source commit before interpreting empty history as a first build", () => {
    gh.mockImplementationOnce(() => {
      throw new Error("Not a valid object name");
    });
    expect(() => requiresTestFlightUpload("owner/dofek", currentSha)).toThrow("Not a valid object");
    expect(gh).toHaveBeenCalledWith("git", ["cat-file", "-e", `${currentSha}^{commit}`], {
      stdio: "inherit",
    });
  });

  it("requests bounded newest-first pages and stops at the latest successful upload", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(
      page([receipt(currentSha), receipt(earlierSha)], true, "next"),
    );
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
    expect(gh).toHaveBeenCalledTimes(2);
    const [command, arguments_, options] = gh.mock.calls[1] ?? [];
    expect(command).toBe("gh");
    expect(arguments_).toEqual(["api", "graphql", "--input", "-"]);
    const request = JSON.parse(String(options?.input));
    expect(request.variables).toEqual({ owner: "owner", name: "dofek", after: null });
    expect(request.query).toMatch(/first:\s*100/);
    expect(request.query).toMatch(/orderBy:\s*\{\s*field:\s*CREATED_AT,\s*direction:\s*DESC\s*\}/);
    expect(request.query).toMatch(/environments:\s*\["testflight"\]/);
    expect(request.query).toContain("latestStatus { state }");
  });

  it("continues past another task and explicitly inactive receipts to a later page", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(
        page(
          [receipt(currentSha, "SUCCESS", "another-task"), receipt(currentSha, "INACTIVE")],
          true,
          "cursor-1",
        ),
      )
      .mockReturnValueOnce(page([receipt(earlierSha)]))
      .mockReturnValueOnce("packages/mobile/package.json\0");
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(true);
    const request = JSON.parse(String(gh.mock.calls[2]?.[2]?.input));
    expect(request.variables).toEqual({ owner: "owner", name: "dofek", after: "cursor-1" });
    expect(gh).toHaveBeenLastCalledWith(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", earlierSha, currentSha, "--"],
      expect.any(Object),
    );
  });

  it.each(["FAILURE", "ERROR", "PENDING", "IN_PROGRESS", "QUEUED", "WAITING", null])(
    "blocks unresolved upload state %s even for explicit manual publication",
    (state) => {
      gh.mockReturnValueOnce("").mockReturnValueOnce(
        page([receipt(currentSha, state), receipt(earlierSha)]),
      );
      expect(() => requiresTestFlightUpload("owner/dofek", currentSha, true)).toThrow(
        `(${currentSha}, ${state ?? "no status"})`,
      );
    },
  );

  it("fails when GitHub cannot establish upload history", () => {
    gh.mockReturnValueOnce("").mockImplementationOnce(() => {
      throw new Error("GitHub API unavailable");
    });
    expect(() => requiresTestFlightUpload("owner/dofek", currentSha)).toThrow(
      "GitHub API unavailable",
    );
  });

  it.each([
    "not-json",
    JSON.stringify({
      errors: [{ message: "Query unavailable" }],
      data: {
        repository: {
          deployments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    }),
    JSON.stringify({ data: { repository: null } }),
    page([{ ...receipt(currentSha), environment: "production" }]),
    page([{ ...receipt(currentSha), commitOid: "invalid" }]),
    page([], true, ""),
  ])(
    "rejects malformed or partial GraphQL evidence instead of assuming no baseline: %s",
    (response) => {
      gh.mockReturnValueOnce("").mockReturnValueOnce(response);
      expect(() => requiresTestFlightUpload("owner/dofek", currentSha)).toThrow();
    },
  );

  it("rejects a missing continuation cursor when more history remains", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(page([], true, null));
    expect(() => requiresTestFlightUpload("owner/dofek", currentSha)).toThrow("cursor");
  });

  it("rejects a continuation cursor that does not advance", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(page([], true, "cursor-1"))
      .mockReturnValueOnce(page([], true, "cursor-1"));
    expect(() => requiresTestFlightUpload("owner/dofek", currentSha)).toThrow("cursor");
  });

  // The workflow callers serialize the non-atomic history-read/create boundary.
  it("creates and marks one upload intent pending before returning its ID", () => {
    gh.mockReturnValueOnce(page())
      .mockReturnValueOnce(JSON.stringify(uploadDeployment()))
      .mockReturnValueOnce('{"state":"pending"}');
    expect(prepareTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toBe(5);
    expect(gh).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["api", "--method", "POST", "repos/owner/dofek/deployments", "--input", "-"],
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
        input: JSON.stringify({
          ref: currentSha,
          environment: "testflight",
          task: "testflight-upload",
          auto_merge: false,
          required_contexts: [],
          production_environment: false,
          payload: { build_number: "1793210000", run_url: runUrl },
        }),
      }),
    );
    expect(gh).toHaveBeenNthCalledWith(
      3,
      "gh",
      ["api", "--method", "POST", "repos/owner/dofek/deployments/5/statuses", "--input", "-"],
      expect.objectContaining({
        input: JSON.stringify({
          state: "pending",
          auto_inactive: false,
          log_url: runUrl,
          description: "TestFlight build 1793210000 awaiting upload",
        }),
      }),
    );
  });

  it("rechecks ambiguity inside an uploader attempt after an earlier detection passed", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(page());
    expect(requiresTestFlightUpload("owner/dofek", currentSha, true)).toBe(true);
    gh.mockReturnValueOnce(page([receipt(currentSha, "PENDING")]));
    expect(() => prepareTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toThrow(
      "Unresolved",
    );
    expect(gh).toHaveBeenCalledTimes(3);
  });

  it("uses a newer confirmed success without resurrecting an older unresolved intent", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(
      page([receipt(currentSha), receipt(earlierSha, "PENDING")]),
    );
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
  });

  it("blocks the next uploader attempt when creating the intent succeeded but pending acknowledgement failed", () => {
    gh.mockReturnValueOnce(page())
      .mockReturnValueOnce(JSON.stringify(uploadDeployment()))
      .mockImplementationOnce(() => {
        throw new Error("Pending status API failed");
      });
    expect(() => prepareTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toThrow(
      "Pending status API failed",
    );
    gh.mockReturnValueOnce(page([receipt(currentSha, null)]));
    expect(() => prepareTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toThrow(
      "Unresolved",
    );
    expect(gh).toHaveBeenCalledTimes(4);
  });

  it("does not mark an intent pending when GitHub returns different upload evidence", () => {
    gh.mockReturnValueOnce(page()).mockReturnValueOnce(
      JSON.stringify(uploadDeployment({ sha: earlierSha })),
    );
    expect(() => prepareTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toThrow(
      "does not match",
    );
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it.each(['{"state":"failure"}', "{}"])(
    "requires acknowledgement of pending intent before permitting upload: %s",
    (response) => {
      gh.mockReturnValueOnce(page())
        .mockReturnValueOnce(JSON.stringify(uploadDeployment()))
        .mockReturnValueOnce(response);
      expect(() =>
        prepareTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl),
      ).toThrow();
    },
  );

  it.each(['{"state":"pending"}', "{}"])(
    "requires acknowledgement of successful finalization: %s",
    (response) => {
      gh.mockReturnValueOnce(JSON.stringify(uploadDeployment()))
        .mockReturnValueOnce(deploymentStatus("PENDING"))
        .mockReturnValueOnce(response);
      expect(() =>
        recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl),
      ).toThrow();
    },
  );

  it("finalizes the original deployment ID without creating another upload intent", () => {
    gh.mockReturnValueOnce(JSON.stringify(uploadDeployment()))
      .mockReturnValueOnce(deploymentStatus("PENDING"))
      .mockReturnValueOnce('{"state":"success"}');
    recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl);
    expect(gh).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["api", "--method", "GET", "repos/owner/dofek/deployments/5"],
      expect.any(Object),
    );
    expect(gh).toHaveBeenNthCalledWith(
      3,
      "gh",
      ["api", "--method", "POST", "repos/owner/dofek/deployments/5/statuses", "--input", "-"],
      expect.objectContaining({
        input: JSON.stringify({
          state: "success",
          auto_inactive: false,
          log_url: runUrl,
          description: "TestFlight build 1793210000 uploaded successfully",
        }),
      }),
    );
  });

  it("preserves an operator's inactive reconciliation instead of posting success", () => {
    gh.mockReturnValueOnce(JSON.stringify(uploadDeployment())).mockReturnValueOnce(
      deploymentStatus("INACTIVE"),
    );
    expect(() =>
      recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl),
    ).toThrow("INACTIVE");
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh).toHaveBeenLastCalledWith(
      "gh",
      ["api", "graphql", "--input", "-"],
      expect.objectContaining({
        input: expect.stringContaining('"id":"D_returned_fixture_node"'),
      }),
    );
  });

  it("returns successfully without another status write when the original receipt is already successful", () => {
    gh.mockReturnValueOnce(JSON.stringify(uploadDeployment())).mockReturnValueOnce(
      deploymentStatus("SUCCESS"),
    );
    recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl);
    expect(gh).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String(gh.mock.calls[1]?.[2]?.input));
    expect(request.variables).toEqual({ id: "D_returned_fixture_node" });
    expect(request.query).toContain("... on Deployment");
    expect(request.query).toContain("latestStatus { state }");
  });

  it.each([
    deploymentStatus("PENDING", 6),
    deploymentStatus(null),
    JSON.stringify({ data: { node: null } }),
    JSON.stringify({
      errors: [{ message: "Not authorized" }],
      data: { node: { databaseId: 5, latestStatus: { state: "PENDING" } } },
    }),
  ])(
    "rejects mismatched or incomplete current-status evidence before finalizing: %s",
    (response) => {
      gh.mockReturnValueOnce(JSON.stringify(uploadDeployment())).mockReturnValueOnce(response);
      expect(() =>
        recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl),
      ).toThrow();
      expect(gh).toHaveBeenCalledTimes(2);
      expect(gh.mock.calls[1]?.[1]).toEqual(["api", "graphql", "--input", "-"]);
    },
  );

  it.each([
    { id: 6 },
    { sha: earlierSha },
    { environment: "production" },
    { task: "other" },
    { payload: { build_number: "different", run_url: runUrl } },
    { payload: { build_number: "1793210000", run_url: `${runUrl}/other-attempt` } },
  ])("rejects mismatched deployment evidence before finalizing: %j", (patch) => {
    gh.mockReturnValueOnce(JSON.stringify(uploadDeployment(patch)));
    expect(() =>
      recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl),
    ).toThrow();
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("reruns only finalization after a failed success write using the same original intent", () => {
    gh.mockReturnValueOnce(JSON.stringify(uploadDeployment()))
      .mockReturnValueOnce(deploymentStatus("PENDING"))
      .mockImplementationOnce(() => {
        throw new Error("Receipt API failed");
      });
    expect(() =>
      recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl),
    ).toThrow("Receipt API failed");
    gh.mockReturnValueOnce(JSON.stringify(uploadDeployment()))
      .mockReturnValueOnce(deploymentStatus("PENDING"))
      .mockReturnValueOnce('{"state":"success"}');
    recordTestFlightUpload("owner/dofek", 5, currentSha, "1793210000", runUrl);
    expect(
      gh.mock.calls.filter(([, args]) => args?.[1] === "--method").map(([, args]) => args?.[3]),
    ).toEqual([
      "repos/owner/dofek/deployments/5",
      "repos/owner/dofek/deployments/5/statuses",
      "repos/owner/dofek/deployments/5",
      "repos/owner/dofek/deployments/5/statuses",
    ]);
  });

  it.each(["build1793210000", "1793210000extra"])(
    "rejects nonnumeric build evidence %s",
    (buildNumber) => {
      expect(() =>
        prepareTestFlightUpload("owner/dofek", currentSha, buildNumber, runUrl),
      ).toThrow();
      expect(() =>
        recordTestFlightUpload("owner/dofek", 5, currentSha, buildNumber, runUrl),
      ).toThrow();
      expect(gh).not.toHaveBeenCalled();
    },
  );
});
