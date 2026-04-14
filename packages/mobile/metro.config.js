const { getDefaultConfig } = require("expo/metro-config");
const { withStorybook } = require("@storybook/react-native/metro/withStorybook");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch all files in the monorepo so workspace deps resolve
config.watchFolders = [monorepoRoot];

// Resolve modules from both the project and the monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

// Enable symlink resolution for pnpm workspace packages
config.resolver.unstable_enableSymlinks = true;

// Set condition names so Metro can resolve package.json "exports" subpaths
config.resolver.unstable_conditionNames = ["react-native", "import", "require", "default"];

// Exclude test and story files from the bundle (colocated files in app/
// would otherwise be picked up as Expo Router routes). Story files are
// only needed in Storybook mode, which uses its own entry point.
config.resolver.blockList =
  process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true"
    ? [/\.test\.[jt]sx?$/]
    : [/\.test\.[jt]sx?$/, /\.stories\.[jt]sx?$/];

// Fix package.json "exports" resolution for pnpm-symlinked workspace
// packages. Metro's built-in getPackageForModule doesn't follow pnpm
// symlinks to find package.json, so exports-based subpath resolution
// silently fails and the file-based fallback can't find files in src/.
// This hook patches getPackageForModule to walk up through symlinks.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const enhanced = {
    ...context,
    getPackageForModule(absoluteModulePath) {
      const result = context.getPackageForModule(absoluteModulePath);
      if (result != null) return result;

      let dir = path.dirname(absoluteModulePath);
      while (dir !== path.dirname(dir)) {
        if (path.basename(dir) === "node_modules") break;
        const packageJsonPath = path.join(dir, "package.json");
        try {
          fs.accessSync(packageJsonPath);
          const packageJson = context.getPackage(packageJsonPath);
          if (packageJson == null) break;
          const relative = path.relative(dir, absoluteModulePath).split(path.sep).join("/");
          return {
            rootPath: dir,
            packageJson,
            packageRelativePath: relative,
          };
        } catch {}
        dir = path.dirname(dir);
      }
      return null;
    },
  };
  return context.resolveRequest(enhanced, moduleName, platform);
};

module.exports = withStorybook(config, {
  enabled: process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true",
  configPath: path.resolve(projectRoot, ".rnstorybook"),
});
