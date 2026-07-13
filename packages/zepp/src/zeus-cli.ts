import path from "node:path";

export interface CommonJsRequire {
  (id: string): unknown;
  resolve(id: string, options?: { paths?: string[] }): string;
}

interface ModuleAlias {
  addAlias(alias: string, target: string): void;
}

function hasAddAlias(value: unknown): value is ModuleAlias {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return typeof Reflect.get(value, "addAlias") === "function";
}

function loadModuleAlias(require: CommonJsRequire, searchPath: string): ModuleAlias {
  const moduleAlias: unknown = require(require.resolve("module-alias", { paths: [searchPath] }));
  if (!hasAddAlias(moduleAlias)) {
    throw new Error("Zeus CLI module-alias dependency is missing addAlias()");
  }
  return moduleAlias;
}

export function runZeusCli(require: CommonJsRequire): void {
  const zeusPackageJsonPath = require.resolve("@zeppos/zeus-cli/package.json");
  const zeusPackageDir = path.dirname(zeusPackageJsonPath);

  loadModuleAlias(require, zeusPackageDir).addAlias(
    "zeppos-app-utils",
    path.join(zeusPackageDir, "private-modules/zeppos-app-utils"),
  );

  require(path.join(zeusPackageDir, "bin/main.js"));
}
