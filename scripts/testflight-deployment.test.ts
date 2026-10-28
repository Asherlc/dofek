import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { recordTestFlightUpload, requiresTestFlightUpload } from "./testflight-deployment.ts";

const gh = vi.mocked(execFileSync);
const currentSha = "a".repeat(40);
const earlierSha = "b".repeat(40);
const runUrl = "https://github.com/owner/dofek/actions/runs/123";
const receipt = (id: number, sha: string, createdAt: string) => ({
  id,
  sha,
  created_at: createdAt,
  environment: "testflight",
  task: "testflight-upload",
});
const status = (state: string, id = 1) => ({
  state,
  id,
  created_at: `2026-10-27T12:00:0${id}Z`,
});

beforeEach(() => gh.mockReset());

describe("TestFlight upload receipts", () => {
  it("honors an explicit manual native publication after validating the exact source commit", () => {
    gh.mockReturnValueOnce("");
    expect(requiresTestFlightUpload("owner/dofek", currentSha, true)).toBe(true);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("builds when successful upload history is genuinely empty", () => {
    gh.mockReturnValueOnce("").mockReturnValueOnce("[[]]");
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
      .mockReturnValueOnce(JSON.stringify([[receipt(1, earlierSha, "2026-10-26T12:00:00Z")]]))
      .mockReturnValueOnce(JSON.stringify([[status("success")]]))
      .mockReturnValueOnce(`${path}\n`);

    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(native);
    expect(gh).toHaveBeenLastCalledWith(
      "git",
      ["diff", "--name-only", earlierSha, currentSha, "--"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  });

  it("skips an exact source commit already uploaded successfully", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(JSON.stringify([[receipt(1, currentSha, "2026-10-26T12:00:00Z")]]))
      .mockReturnValueOnce(JSON.stringify([[status("success")]]));
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
    expect(gh).toHaveBeenCalledTimes(3);
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

  it("uses the latest successful actual upload SHA across paginated deployment receipts", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(
        JSON.stringify([
          [receipt(1, earlierSha, "2026-10-26T12:00:00Z")],
          [receipt(2, currentSha, "2026-10-27T12:00:00Z")],
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([[status("success")]]));

    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
    expect(gh).toHaveBeenNthCalledWith(
      2,
      "gh",
      [
        "api",
        "--method",
        "GET",
        "repos/owner/dofek/deployments",
        "-f",
        "environment=testflight",
        "-f",
        "task=testflight-upload",
        "-F",
        "per_page=100",
        "--paginate",
        "--slurp",
      ],
      expect.any(Object),
    );
    expect(gh).toHaveBeenLastCalledWith(
      "gh",
      expect.arrayContaining(["repos/owner/dofek/deployments/2/statuses", "--paginate", "--slurp"]),
      expect.any(Object),
    );
  });

  it("ignores an incomplete receipt and retains successful evidence across status pages", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(
        JSON.stringify([
          [
            receipt(2, currentSha, "2026-10-27T12:00:00Z"),
            receipt(1, earlierSha, "2026-10-26T12:00:00Z"),
          ],
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([[status("pending")]]))
      .mockReturnValueOnce(JSON.stringify([[status("pending")], [status("success", 2)]]))
      .mockReturnValueOnce("packages/mobile/package.json\n");

    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(true);
    expect(gh).toHaveBeenLastCalledWith(
      "git",
      ["diff", "--name-only", earlierSha, currentSha, "--"],
      expect.any(Object),
    );
  });

  it("builds when the latest receipt status supersedes a historical success", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(JSON.stringify([[receipt(1, currentSha, "2026-10-27T12:00:00Z")]]))
      .mockReturnValueOnce(JSON.stringify([[status("success")], [status("failure", 2)]]));
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(true);
  });

  it("builds when retained receipts have no successful status", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(JSON.stringify([[receipt(1, currentSha, "2026-10-27T12:00:00Z")]]))
      .mockReturnValueOnce("[[]]");
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(true);
  });

  it("selects the newer receipt ID when uploads share a timestamp", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(
        JSON.stringify([
          [
            receipt(1, earlierSha, "2026-10-27T12:00:00Z"),
            receipt(2, currentSha, "2026-10-27T12:00:00Z"),
          ],
        ]),
      )
      .mockReturnValueOnce(JSON.stringify([[status("success")]]));
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
    expect(gh).toHaveBeenLastCalledWith(
      "gh",
      expect.arrayContaining(["repos/owner/dofek/deployments/2/statuses"]),
      expect.any(Object),
    );
  });

  it("selects the newer status ID when receipt states share a timestamp", () => {
    gh.mockReturnValueOnce("")
      .mockReturnValueOnce(JSON.stringify([[receipt(1, currentSha, "2026-10-27T12:00:00Z")]]))
      .mockReturnValueOnce(
        JSON.stringify([
          [status("failure"), { ...status("success", 2), created_at: "2026-10-27T12:00:01Z" }],
        ]),
      );
    expect(requiresTestFlightUpload("owner/dofek", currentSha)).toBe(false);
  });

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
    '[{"sha":"invalid"}]',
    JSON.stringify([
      [{ ...receipt(1, currentSha, "2026-10-27T12:00:00Z"), environment: "production" }],
    ]),
  ])("rejects malformed or unrelated history instead of assuming no baseline: %s", (response) => {
    gh.mockReturnValueOnce("").mockReturnValueOnce(response);
    expect(() => requiresTestFlightUpload("owner/dofek", currentSha)).toThrow();
  });

  it("records the actual uploaded commit before marking that receipt successful", () => {
    gh.mockReturnValueOnce(JSON.stringify({ id: 5, sha: currentSha })).mockReturnValueOnce(
      '{"state":"success"}',
    );

    recordTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl);

    expect(gh).toHaveBeenNthCalledWith(
      1,
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
          payload: { build_number: "1793210000" },
        }),
      }),
    );
    expect(gh).toHaveBeenNthCalledWith(
      2,
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

  it("rejects a receipt for a different source commit before marking it successful", () => {
    gh.mockReturnValueOnce(JSON.stringify({ id: 5, sha: earlierSha }));
    expect(() => recordTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toThrow(
      "different commit",
    );
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("fails when the success receipt cannot be confirmed", () => {
    gh.mockReturnValueOnce(JSON.stringify({ id: 5, sha: currentSha })).mockReturnValueOnce(
      '{"state":"failure"}',
    );
    expect(() => recordTestFlightUpload("owner/dofek", currentSha, "1793210000", runUrl)).toThrow();
  });

  it("rejects an unresolved source reference before creating a receipt", () => {
    expect(() => recordTestFlightUpload("owner/dofek", "main", "1793210000", runUrl)).toThrow();
    expect(gh).not.toHaveBeenCalled();
  });

  it.each(["build1793210000", "1793210000extra"])(
    "rejects a nonnumeric upload build number %s before recording it",
    (buildNumber) => {
      expect(() =>
        recordTestFlightUpload("owner/dofek", currentSha, buildNumber, runUrl),
      ).toThrow();
      expect(gh).not.toHaveBeenCalled();
    },
  );
});
