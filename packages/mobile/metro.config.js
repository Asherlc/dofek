const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativeWind } = require('nativewind/metro');

/** @type {import('expo/metro-config').MetroConfig} */
let config = getSentryExpoConfig(__dirname, {
  // [Web-only]: Enables CSS support in Metro.
  isCSSEnabled: true,
});

config = withNativeWind(config, { input: './global.css' })

// 1. Watch all files in the monorepo
config.watchFolders = [__dirname, `${__dirname}/../../packages`];

// 2. Let Metro know where to resolve packages and in what order
config.resolver.nodeModulesPaths = [
  ...config.resolver.nodeModulesPaths,
  `${__dirname}/node_modules`,
  `${__dirname}/../../node_modules`,
];

// 3. Force Metro to resolve (sub)dependencies from the `node_modules` in the root of the monorepo
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
