import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "test-ios-bridge.ts");
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const roots: string[] = [];
interface Invocation {
  tool: string;
  args: string[];
  cwd: string;
  sourceModules: string;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "whoop-bridge-runner-")));
  roots.push(root);
  const mobile = join(root, "mobile");
  const ios = join(mobile, "ios");
  const bin = join(root, "bin");
  mkdirSync(join(mobile, "scripts"), { recursive: true });
  mkdirSync(ios);
  mkdirSync(bin);
  const helper = join(root, "native-helper");
  mkdirSync(join(helper, "ios"), { recursive: true });
  writeFileSync(
    join(helper, "package.json"),
    JSON.stringify({ name: "expo-modules-test-core", version: "58.0.5" }),
  );
  mkdirSync(join(mobile, "node_modules"));
  symlinkSync(helper, join(mobile, "node_modules/expo-modules-test-core"));
  const runner = join(mobile, "scripts/test-ios-bridge.ts");
  writeFileSync(runner, readFileSync(script));
  const podfile = join(ios, "Podfile");
  writeFileSync(podfile, "platform :ios, '16.4'\ntarget 'Dofek' do\nend\n");
  const log = join(root, "calls.jsonl");
  const state = join(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      devices: {
        "iOS-27": [
          { name: "iPhone Fresh", udid: "fresh", state: "Shutdown" },
          { name: "iPhone Running", udid: "running", state: "Booted" },
        ],
      },
    }),
  );
  for (const tool of ["pod", "xcrun", "xcodebuild"]) {
    const path = join(bin, tool);
    writeFileSync(
      path,
      `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const tool = ${JSON.stringify(tool)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool, args: process.argv.slice(2), cwd: process.cwd(), sourceModules: process.env.EXPO_USE_PRECOMPILED_MODULES}) + '\\n');
if (state.fail === tool) { console.error(tool + ' fixture fatal'); process.exit(17); }
if (tool === 'xcrun') process.stdout.write(JSON.stringify({devices: state.devices}));
`,
    );
    chmodSync(path, 0o755);
  }
  return {
    ios,
    helper,
    podfile,
    configure: (value: unknown) => writeFileSync(state, JSON.stringify(value)),
    run: () =>
      spawnSync(process.execPath, [tsx, runner], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
    calls: (): Invocation[] => {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("iOS bridge runner CLI", () => {
  it("fails with the prebuild remedy before running tools when the native project is missing", () => {
    const setup = fixture();
    rmSync(setup.podfile);
    const result = setup.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pnpm prebuild");
    expect(setup.calls()).toEqual([]);
  });

  it("installs the test specification once and runs the real test scheme on the booted phone", () => {
    const setup = fixture();
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = setup.calls();
    expect(calls.map((call) => call.tool)).toEqual(["pod", "xcrun", "xcodebuild"]);
    expect(calls[0]).toMatchObject({ args: ["install"], cwd: setup.ios, sourceModules: "0" });
    expect(calls[2]?.args).toEqual(
      expect.arrayContaining([
        "test",
        "Pods/Pods.xcodeproj",
        "ExpoWhoopBle-Unit-BridgeTests",
        "platform=iOS Simulator,id=running",
      ]),
    );
    const prepared = readFileSync(setup.podfile, "utf8");
    expect(prepared).toContain(":testspecs => ['BridgeTests']");
    expect(prepared).toContain("pod 'ExpoModulesTestCore'");
    expect(prepared).toContain(join(setup.helper, "ios"));
    expect(setup.run().status).toBe(0);
    expect(readFileSync(setup.podfile, "utf8")).toBe(prepared);
  });

  it("selects an available phone when none is booted", () => {
    const setup = fixture();
    setup.configure({
      devices: { "iOS-27": [{ name: "iPhone Fresh", udid: "fresh", state: "Shutdown" }] },
    });
    expect(setup.run().status).toBe(0);
    expect(setup.calls()[2]?.args).toContain("platform=iOS Simulator,id=fresh");
  });

  it("fails with the simulator prerequisite instead of invoking tests on a different device", () => {
    const setup = fixture();
    setup.configure({
      devices: { "tvOS-27": [{ name: "Apple TV", udid: "tv", state: "Booted" }] },
    });
    const result = setup.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Install an iPhone Simulator runtime");
    expect(setup.calls().map((call) => call.tool)).toEqual(["pod", "xcrun"]);
  });

  it.each(["pod", "xcodebuild"])("propagates %s failure without continuing", (tool) => {
    const setup = fixture();
    setup.configure({
      fail: tool,
      devices: { iOS: [{ name: "iPhone Test", udid: "phone", state: "Booted" }] },
    });
    const result = setup.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${tool} fixture fatal`);
    expect(setup.calls().at(-1)?.tool).toBe(tool);
  });

  it("rejects an unexpected Podfile rather than installing without the test specification", () => {
    const setup = fixture();
    writeFileSync(setup.podfile, "target 'DifferentApp' do\nend\n");
    const result = setup.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("pnpm prebuild");
    expect(setup.calls()).toEqual([]);
  });
});
