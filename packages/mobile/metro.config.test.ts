import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Tests for the pnpm symlink fix in metro.config.js.
 *
 * Metro's built-in getPackageForModule doesn't follow pnpm symlinks to
 * find package.json files, so exports-based subpath resolution fails.
 * The resolveRequest hook patches getPackageForModule to walk up through
 * symlinks and return the correct packageRelativePath.
 */

// Extract the resolveRequest function from metro.config.js
// We load it and pull the configured resolveRequest off the exported config.
// biome-ignore lint/suspicious/noExplicitAny: metro config has no TS types
let resolveRequest: any;

// metro.config.js uses require("expo/metro-config") which isn't available in
// vitest, so we mock it and capture the resolveRequest that gets assigned.
vi.mock("expo/metro-config", () => ({
  getDefaultConfig: () => ({
    watchFolders: [],
    resolver: {
      nodeModulesPaths: [],
      unstable_enableSymlinks: false,
      unstable_conditionNames: [],
      blockList: [],
    },
  }),
}));

// Load the config to capture the resolveRequest function
const config = require("./metro.config.js");
resolveRequest = config.resolver.resolveRequest;

describe("metro.config.js resolveRequest", () => {
  it("delegates to default resolver when getPackageForModule returns a result", () => {
    const existingResult = {
      rootPath: "/some/package",
      packageJson: { name: "test", exports: { ".": "./index.js" } },
      packageRelativePath: "index.js",
    };
    const defaultResolve = vi.fn().mockReturnValue({ type: "sourceFile", filePath: "/resolved" });
    const context = {
      getPackageForModule: () => existingResult,
      getPackage: () => null,
      resolveRequest: defaultResolve,
    };

    resolveRequest(context, "some-module", "ios");

    expect(defaultResolve).toHaveBeenCalledOnce();
    // The enhanced context should still return the original result
    const enhancedCtx = defaultResolve.mock.calls[0][0];
    expect(enhancedCtx.getPackageForModule("/some/path")).toBe(existingResult);
  });

  it("walks up directories through symlinks when getPackageForModule returns null", () => {
    const monorepoRoot = path.resolve(__dirname, "../..");
    const providersRoot = path.resolve(monorepoRoot, "packages/providers-meta");
    const candidatePath = path.join(providersRoot, "providers");

    const defaultResolve = vi.fn().mockReturnValue({ type: "sourceFile", filePath: "/resolved" });
    const context = {
      getPackageForModule: () => null,
      getPackage: (pkgPath: string) => {
        return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      },
      resolveRequest: defaultResolve,
    };

    resolveRequest(context, "@dofek/providers/providers", "ios");

    const enhancedCtx = defaultResolve.mock.calls[0][0];
    const result = enhancedCtx.getPackageForModule(candidatePath);

    expect(result).not.toBeNull();
    expect(result.rootPath).toBe(providersRoot);
    expect(result.packageJson.name).toBe("@dofek/providers");
    expect(result.packageRelativePath).toBe("providers");
  });

  it("stops at node_modules boundary", () => {
    const defaultResolve = vi.fn().mockReturnValue({ type: "sourceFile", filePath: "/resolved" });
    const context = {
      getPackageForModule: () => null,
      getPackage: () => null,
      resolveRequest: defaultResolve,
    };

    resolveRequest(context, "some-module", "ios");

    const enhancedCtx = defaultResolve.mock.calls[0][0];
    // A path inside node_modules should stop walking at the boundary
    const result = enhancedCtx.getPackageForModule("/fake/node_modules/pkg/sub");
    expect(result).toBeNull();
  });

  it("resolves packageRelativePath with forward slashes", () => {
    const monorepoRoot = path.resolve(__dirname, "../..");
    const formatRoot = path.resolve(monorepoRoot, "packages/format");
    const candidatePath = path.join(formatRoot, "format");

    const defaultResolve = vi.fn().mockReturnValue({ type: "sourceFile", filePath: "/resolved" });
    const context = {
      getPackageForModule: () => null,
      getPackage: (pkgPath: string) => {
        return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      },
      resolveRequest: defaultResolve,
    };

    resolveRequest(context, "@dofek/format/format", "ios");

    const enhancedCtx = defaultResolve.mock.calls[0][0];
    const result = enhancedCtx.getPackageForModule(candidatePath);

    expect(result).not.toBeNull();
    expect(result.packageRelativePath).toBe("format");
    expect(result.packageRelativePath).not.toContain("\\");
  });
});
