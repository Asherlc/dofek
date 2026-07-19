import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./patch-release-version.ts", import.meta.url));
const tsxCliPath = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("patch-release-version", () => {
  it("updates both independently released Zepp packages", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dofek-zepp-version-"));
    const manifest = { app: { version: { code: 1, name: "1.0.0" } } };
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
        app: { version: { code: 20304, name: "2.3.4" } },
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
