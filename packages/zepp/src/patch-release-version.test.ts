import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const fileMocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("node:fs/promises", () => fileMocks);

const scriptPath = fileURLToPath(new URL("./patch-release-version.ts", import.meta.url));
const tsxCliPath = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const originalArguments = process.argv;

afterEach(() => {
  process.argv = originalArguments;
  vi.clearAllMocks();
  vi.resetModules();
});

describe("patch-release-version", () => {
  it("patches manifests and package metadata through the script entry point", async () => {
    process.argv = [process.execPath, scriptPath, "30.40.50", "304050"];
    fileMocks.readFile.mockImplementation(async (path: string) =>
      JSON.stringify(
        path.endsWith("app.json") || path.endsWith("app.template.json")
          ? { app: { appId: 123456, version: { code: 1, name: "1.0.0" } }, preserved: true }
          : { name: "fixture", version: "1.0.0", preserved: true },
      ),
    );

    await import("./patch-release-version.ts");

    expect(fileMocks.writeFile).toHaveBeenCalledTimes(4);
    expect(fileMocks.writeFile).toHaveBeenCalledWith(
      "packages/zepp/app.json",
      expect.stringContaining('"appId": 123456'),
    );
    expect(fileMocks.writeFile).toHaveBeenCalledWith(
      "packages/zepp/workout-extension/package.json",
      expect.stringContaining('"version": "30.40.50"'),
    );
    expect(
      fileMocks.writeFile.mock.calls.every(([, contents]) => String(contents).endsWith("\n")),
    ).toBe(true);
  });

  it.each(["x1.2.3", "1.2.3x"])("rejects invalid version %s", async (version) => {
    process.argv = [process.execPath, scriptPath, version, "10203"];
    await expect(import("./patch-release-version.ts")).rejects.toThrow();
    expect(fileMocks.readFile).not.toHaveBeenCalled();
  });

  it.each([
    ["manifest without app", {}],
    ["manifest without version", { app: {} }],
    ["package without version", { version: undefined }],
  ])("rejects malformed %s metadata", async (_, malformedValue) => {
    process.argv = [process.execPath, scriptPath, "1.2.3", "10203"];
    fileMocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("package.json") && "version" in malformedValue) {
        return JSON.stringify(malformedValue);
      }
      if (path.endsWith("app.json") && !("version" in malformedValue)) {
        return JSON.stringify(malformedValue);
      }
      return JSON.stringify({ app: { version: { code: 1, name: "1.0.0" } } });
    });
    await expect(import("./patch-release-version.ts")).rejects.toThrow();
  });

  it("updates both independently released Zepp packages", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dofek-zepp-version-"));
    const manifest = { app: { appId: 123456, version: { code: 1, name: "1.0.0" } } };
    const packageJson = { name: "fixture", version: "1.0.0" };
    writeJson(join(workspace, "packages/zepp/app.json"), manifest);
    writeJson(join(workspace, "packages/zepp/package.json"), packageJson);
    writeJson(join(workspace, "packages/zepp/workout-extension/app.template.json"), manifest);
    writeJson(join(workspace, "packages/zepp/workout-extension/package.json"), packageJson);

    execFileSync(process.execPath, [tsxCliPath, scriptPath, "2.3.4", "20304"], {
      cwd: workspace,
      stdio: "pipe",
    });

    for (const path of [
      "packages/zepp/app.json",
      "packages/zepp/workout-extension/app.template.json",
    ]) {
      expect(JSON.parse(readFileSync(join(workspace, path), "utf8"))).toMatchObject({
        app: { appId: 123456, version: { code: 20304, name: "2.3.4" } },
      });
    }
    for (const path of [
      "packages/zepp/package.json",
      "packages/zepp/workout-extension/package.json",
    ]) {
      expect(JSON.parse(readFileSync(join(workspace, path), "utf8"))).toMatchObject({
        version: "2.3.4",
      });
    }
  });
});
