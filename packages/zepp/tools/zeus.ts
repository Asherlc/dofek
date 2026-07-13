import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface ModuleAlias {
  addAlias(alias: string, target: string): void;
}

function hasAddAlias(value: unknown): value is ModuleAlias {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return typeof (value as { addAlias?: unknown }).addAlias === "function";
}

function loadModuleAlias(searchPath: string): ModuleAlias {
  const moduleAlias: unknown = require(require.resolve("module-alias", { paths: [searchPath] }));
  if (!hasAddAlias(moduleAlias)) {
    throw new Error("Zeus CLI module-alias dependency is missing addAlias()");
  }
  return moduleAlias;
}

const zeusPackageJsonPath = require.resolve("@zeppos/zeus-cli/package.json");
const zeusPackageDir = path.dirname(zeusPackageJsonPath);

loadModuleAlias(zeusPackageDir).addAlias(
  "zeppos-app-utils",
  path.join(zeusPackageDir, "private-modules/zeppos-app-utils"),
);

require(path.join(zeusPackageDir, "bin/main.js"));
