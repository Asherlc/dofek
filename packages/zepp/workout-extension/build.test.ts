import { afterEach, describe, expect, it, vi } from "vitest";

const fileMocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
const buildMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => fileMocks);
vi.mock("esbuild", () => ({ build: buildMock }));

afterEach(() => {
  delete process.env.ZEPP_WORKOUT_EXTENSION_APP_ID;
  vi.clearAllMocks();
  vi.resetModules();
});

describe("workout extension build", () => {
  it("generates the provisioned manifest, assets, and bundled entry points", async () => {
    process.env.ZEPP_WORKOUT_EXTENSION_APP_ID = "1000000";
    fileMocks.readFile.mockResolvedValue(
      JSON.stringify({ app: { appId: 0, version: { code: 1, name: "1.0.0" } } }),
    );

    await import("./build.ts");

    expect(fileMocks.readFile).toHaveBeenCalledWith("workout-extension/app.template.json", "utf8");
    expect(fileMocks.writeFile).toHaveBeenCalledWith(
      "workout-extension/app.json",
      expect.stringContaining('"appId": 1000000'),
    );
    expect(fileMocks.mkdir).toHaveBeenNthCalledWith(1, "workout-extension/assets/common.r", {
      recursive: true,
    });
    expect(fileMocks.mkdir).toHaveBeenNthCalledWith(2, "workout-extension/assets/common.s", {
      recursive: true,
    });
    expect(fileMocks.copyFile).toHaveBeenCalledTimes(2);
    expect(buildMock).toHaveBeenCalledWith({
      bundle: true,
      define: {
        DOFEK_COMPANION_CONNECTION_TYPE: JSON.stringify("zepp-workout"),
      },
      platform: "neutral",
      target: "es2022",
      format: "esm",
      external: ["@zos/*", "@zeppos/*"],
      allowOverwrite: true,
      outdir: "workout-extension",
      entryPoints: [
        { in: "workout-extension/app.ts", out: "app" },
        { in: "workout-extension/data-widget/index.ts", out: "data-widget/index" },
        { in: "app-side/index.ts", out: "app-side/index" },
        { in: "workout-extension/setting/index.ts", out: "setting/index" },
      ],
    });
  });

  it("fails before writing when the extension app ID is invalid", async () => {
    process.env.ZEPP_WORKOUT_EXTENSION_APP_ID = "0";

    await expect(import("./build.ts")).rejects.toThrow(
      "ZEPP_WORKOUT_EXTENSION_APP_ID must be set",
    );
    expect(fileMocks.writeFile).not.toHaveBeenCalled();
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("rejects malformed manifest templates", async () => {
    process.env.ZEPP_WORKOUT_EXTENSION_APP_ID = "1234567";
    fileMocks.readFile.mockResolvedValueOnce("{}");
    await expect(import("./build.ts")).rejects.toThrow(
      "missing its app configuration",
    );

    vi.resetModules();
    fileMocks.readFile.mockResolvedValueOnce('{"app":null}');
    await expect(import("./build.ts")).rejects.toThrow(
      "invalid app configuration",
    );

    vi.resetModules();
    fileMocks.readFile.mockResolvedValueOnce("null");
    await expect(import("./build.ts")).rejects.toThrow(
      "missing its app configuration",
    );

    vi.resetModules();
    fileMocks.readFile.mockResolvedValueOnce('{"app":"invalid"}');
    await expect(import("./build.ts")).rejects.toThrow(
      "invalid app configuration",
    );
  });
});
