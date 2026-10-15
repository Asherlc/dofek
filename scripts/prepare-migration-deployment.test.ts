import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const requestedImage = "ghcr.io/asherlc/dofek:sha-new";
const deployedImage = `ghcr.io/asherlc/dofek:sha-old@sha256:${"a".repeat(64)}`;
const oldEntry = { idx: 0, tag: "0000_baseline", when: 1 };
const newEntry = { idx: 1, tag: "0001_contract_change", when: 2 };

function prepareDeployment({
  serviceNames = ["dofek_web"],
  currentImage = deployedImage,
  targetImage = requestedImage,
  failure,
  marked = true,
  oldJournal = JSON.stringify({ entries: [oldEntry] }),
  targetEntries = [oldEntry, newEntry],
  stackName = "dofek",
  outputAvailable = true,
  maintenanceBoundary,
}: {
  serviceNames?: string[];
  currentImage?: string;
  targetImage?: string;
  failure?: string;
  marked?: boolean;
  oldJournal?: string;
  targetEntries?: Array<typeof oldEntry>;
  stackName?: string;
  outputAvailable?: boolean;
  maintenanceBoundary?: unknown;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "prepare-migration-deployment-test-"));
  const binaryDirectory = join(directory, "bin");
  const temporaryDirectory = join(directory, "temporary");
  const fixtureDirectory = join(directory, "fixture");
  const containersDirectory = join(directory, "containers");
  const callsPath = join(directory, "docker-calls.jsonl");
  const outputPath = join(directory, "output");
  for (const path of [binaryDirectory, temporaryDirectory, fixtureDirectory, containersDirectory])
    mkdirSync(path);
  mkdirSync(join(fixtureDirectory, "meta"));
  writeFileSync(
    join(fixtureDirectory, "meta/_journal.json"),
    JSON.stringify({ entries: targetEntries }),
  );
  writeFileSync(join(directory, "old-journal.json"), oldJournal);
  for (const entry of targetEntries)
    writeFileSync(
      join(fixtureDirectory, `${entry.tag}.sql`),
      `${marked && entry.idx === 1 ? "-- dofek: deployment-mode=maintenance\n" : ""}SELECT 1;\n`,
    );
  writeFileSync(callsPath, "");
  writeFileSync(outputPath, "existing=value\n");
  const scenarioPath = join(directory, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify({
      serviceNames,
      currentImage,
      targetImage,
      failure,
      fixtureDirectory,
      directory,
      maintenanceBoundary,
    }),
  );
  const dockerPath = join(binaryDirectory, "docker");
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
const { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.MIGRATION_TEST_SCENARIO, "utf8"));
appendFileSync(join(scenario.directory, "docker-calls.jsonl"), JSON.stringify(args) + "\\n");
const targetId = "b".repeat(64);
const deployedId = "c".repeat(64);
let operation;
if (args[0] === "service" && args[1] === "ls") operation = "list";
else if (args[0] === "service" && args[1] === "inspect") operation = "inspect";
else if (args[0] === "create") operation = args.at(-1) === scenario.targetImage ? "create-target" : "create-deployed";
else if (args[0] === "cp") operation = args[1].startsWith(targetId + ":") ? "copy-target" : "copy-deployed";
else if (args[0] === "rm") operation = args.at(-1) === targetId ? "remove-target" : "remove-deployed";
else { console.error("Unexpected Docker operation"); process.exit(65); }
if (scenario.failure === operation) { console.error("Docker " + operation + " failed"); process.exit(23); }
if (operation === "list") process.stdout.write(scenario.serviceNames.join("\\n"));
else if (operation === "inspect") {
  if (args.includes("--format")) process.stdout.write(scenario.currentImage);
  else process.stdout.write(JSON.stringify([{
    Spec: {
      Labels: {
        "com.docker.stack.namespace": "dofek",
        ...(scenario.maintenanceBoundary === undefined ? {} : { "dofek.migration-maintenance-target": scenario.maintenanceBoundary }),
      },
      TaskTemplate: { ContainerSpec: { Image: scenario.currentImage } },
    },
  }]));
}
else if (operation.startsWith("create-")) {
  const id = operation === "create-target" ? targetId : deployedId;
  mkdirSync(join(scenario.directory, "containers", id));
  process.stdout.write(id);
} else if (operation === "copy-target") {
  if (args[1] !== targetId + ":/app/drizzle/.") process.exit(66);
  cpSync(scenario.fixtureDirectory, args[2], { recursive: true });
} else if (operation === "copy-deployed") {
  if (args[1] !== deployedId + ":/app/drizzle/meta/_journal.json") process.exit(67);
  cpSync(join(scenario.directory, "old-journal.json"), args[2]);
} else rmSync(join(scenario.directory, "containers", args.at(-1)), { recursive: true });
`,
  );
  chmodSync(dockerPath, 0o755);

  try {
    const environment = {
      ...process.env,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      TMPDIR: temporaryDirectory,
      GITHUB_OUTPUT: outputAvailable ? outputPath : undefined,
      MIGRATION_TEST_SCENARIO: scenarioPath,
    };
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("scripts/prepare-migration-deployment.ts"),
        targetImage,
        stackName,
      ],
      { env: environment, encoding: "utf8" },
    );
    const calls = readFileSync(callsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): string[] => JSON.parse(line));
    return {
      ...result,
      output: readFileSync(outputPath, "utf8"),
      calls,
      remainingContainers: readdirSync(containersDirectory),
      remainingTemporaryDirectories: readdirSync(temporaryDirectory).filter((name) =>
        name.startsWith("dofek-migration-deployment-"),
      ),
      copiedFixturesRemain: existsSync(fixtureDirectory),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("prepare migration deployment command", () => {
  it("selects maintenance across a marked boundary and preserves the inspected image digest", () => {
    const result = prepareDeployment();
    expect(result.status).toBe(0);
    expect(result.output).toBe(
      `existing=value\nmode=maintenance\npre_migration_image_tag=sha-old@sha256:${"a".repeat(64)}\nmaintenance_boundary=0001_contract_change\n`,
    );
    expect(result.remainingContainers).toEqual([]);
    expect(result.remainingTemporaryDirectories).toEqual([]);
    expect(result.copiedFixturesRemain).toBe(true);
    expect(
      result.calls.filter(([command]) => command === "create").map((call) => call.at(-1)),
    ).toEqual([requestedImage, deployedImage]);
  });

  it("selects rolling when the image histories have no pending maintenance boundary", () => {
    const result = prepareDeployment({ marked: false });
    expect(result.status).toBe(0);
    expect(result.output).toContain("mode=rolling\n");
  });

  it("keeps an interrupted maintenance deployment in maintenance after the new image was installed", () => {
    const result = prepareDeployment({
      marked: false,
      oldJournal: JSON.stringify({ entries: [oldEntry, newEntry] }),
      maintenanceBoundary: "0001_contract_change",
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("mode=maintenance\n");
    expect(result.output).toContain("maintenance_boundary=0001_contract_change\n");
  });

  it("rejects an old image request after the migration committed while the old service image remains", () => {
    const result = prepareDeployment({
      targetEntries: [oldEntry],
      maintenanceBoundary: "0001_contract_change",
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("existing=value\n");
    expect(result.remainingContainers).toEqual([]);
    expect(result.remainingTemporaryDirectories).toEqual([]);
  });

  it.each([42, "", "../0001_contract_change", "0001_contract_change\nmode=rolling"])(
    "rejects an invalid maintenance boundary %j before creating containers",
    (maintenanceBoundary) => {
      const result = prepareDeployment({ maintenanceBoundary });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("existing=value\n");
      expect(result.calls.some(([command]) => command === "create")).toBe(false);
    },
  );

  it.each([undefined, null])("accepts an absent maintenance boundary %j", (maintenanceBoundary) => {
    const result = prepareDeployment({ marked: false, maintenanceBoundary });
    expect(result.status).toBe(0);
    expect(result.output).toContain("mode=rolling\n");
  });

  it("selects maintenance on a fresh stack without inspecting a similarly named service", () => {
    const result = prepareDeployment({ serviceNames: ["dofek_web-preview"] });
    expect(result.status).toBe(0);
    expect(result.output).toBe(
      "existing=value\nmode=maintenance\npre_migration_image_tag=sha-new\nmaintenance_boundary=0001_contract_change\n",
    );
    expect(result.calls.some((call) => call[0] === "service" && call[1] === "inspect")).toBe(false);
    expect(result.remainingContainers).toEqual([]);
  });

  it.each(["list", "inspect", "create-target", "copy-target", "create-deployed", "copy-deployed"])(
    "fails closed and cleans created resources when Docker %s fails",
    (failure) => {
      const result = prepareDeployment({ failure });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Docker ${failure} failed`);
      expect(result.output).toBe("existing=value\n");
      expect(result.remainingContainers).toEqual([]);
      expect(result.remainingTemporaryDirectories).toEqual([]);
    },
  );

  it("does not emit successful outputs when removing an inspection container fails", () => {
    const result = prepareDeployment({ failure: "remove-target" });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("existing=value\n");
    expect(result.remainingTemporaryDirectories).toEqual([]);
  });

  it.each([
    `ghcr.io/other/dofek:sha-old@sha256:${"a".repeat(64)}`,
    "ghcr.io/asherlc/dofek:sha-old",
    "ghcr.io/asherlc/dofek:sha-old@sha256:broken",
  ])("rejects an unverifiable deployed image %s before creating containers", (currentImage) => {
    const result = prepareDeployment({ currentImage });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("existing=value\n");
    expect(result.calls.some(([command]) => command === "create")).toBe(false);
  });

  it.each(["ghcr.io/other/dofek:sha-new", "ghcr.io/asherlc/dofek:sha-new\nmode=rolling"])(
    "rejects an invalid requested image before calling Docker",
    (targetImage) => {
      const result = prepareDeployment({ targetImage });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("existing=value\n");
      expect(result.calls).toEqual([]);
    },
  );

  it("fails without the standard GitHub output file before calling Docker", () => {
    const result = prepareDeployment({ outputAvailable: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GITHUB_OUTPUT");
    expect(result.calls).toEqual([]);
  });

  it.each(["invalid JSON", "null"])(
    "rejects an invalid copied journal %s and removes both inspection containers",
    (oldJournal) => {
      const result = prepareDeployment({ oldJournal });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("existing=value\n");
      expect(result.remainingContainers).toEqual([]);
      expect(result.remainingTemporaryDirectories).toEqual([]);
    },
  );

  it("rejects a deployment whose image history moves behind the deployed image", () => {
    const result = prepareDeployment({
      targetEntries: [oldEntry],
      oldJournal: JSON.stringify({ entries: [oldEntry, newEntry] }),
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("existing=value\n");
    expect(result.remainingContainers).toEqual([]);
    expect(result.remainingTemporaryDirectories).toEqual([]);
  });
});
