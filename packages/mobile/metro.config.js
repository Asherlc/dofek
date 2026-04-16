const { getSentryExpoConfig } = require("@sentry/react-native/metro");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getSentryExpoConfig(__dirname);

// Watch all files in the monorepo
config.watchFolders = [__dirname, `${__dirname}/../../packages`];

// Resolve modules from both the project and the monorepo root
config.resolver.nodeModulesPaths = [
  ...config.resolver.nodeModulesPaths,
  `${__dirname}/node_modules`,
  `${__dirname}/../../node_modules`,
];

// Enable symlink resolution for pnpm workspace packages
config.resolver.unstable_enableSymlinks = true;

// Set condition names so Metro can resolve package.json "exports" subpaths
config.resolver.unstable_conditionNames = ["react-native", "import", "require", "default"];

// Exclude test and story files from the bundle
config.resolver.blockList = [/\.test\.[jt]sx?$/, /\.stories\.[jt]sx?$/];

module.exports = config;
