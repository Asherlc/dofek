import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-native-web-vite";

const currentDir = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx)", "../app-stories/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-native-web-vite",
  docs: {
    autodocs: "tag",
  },
  viteFinal: (viteConfig) => {
    viteConfig.resolve ??= {};
    viteConfig.plugins ??= [];
    const existingAliases = Array.isArray(viteConfig.resolve.alias)
      ? viteConfig.resolve.alias
      : Object.entries(viteConfig.resolve.alias ?? {}).map(([find, replacement]) => ({
          find,
          replacement,
        }));
    viteConfig.resolve.alias = [
      ...existingAliases,
      {
        find: "@react-native-community/datetimepicker",
        replacement: resolve(currentDir, "./mocks/react-native-community-datetimepicker.tsx"),
      },
      {
        find: "expo-modules-core",
        replacement: resolve(currentDir, "./mocks/expo-modules-core.ts"),
      },
      {
        find: /^expo-router$/,
        replacement: resolve(currentDir, "./mocks/expo-router.ts"),
      },
      {
        find: "expo-updates",
        replacement: resolve(currentDir, "./mocks/expo-updates.ts"),
      },
      {
        find: "react-native-maps",
        replacement: resolve(currentDir, "./mocks/react-native-maps.tsx"),
      },
      {
        find: "react-native-reanimated",
        replacement: resolve(currentDir, "./mocks/react-native-reanimated.tsx"),
      },
      {
        find: resolve(currentDir, "../lib/auth-context"),
        replacement: resolve(currentDir, "./mocks/auth-context"),
      },
      {
        find: resolve(currentDir, "../lib/auth-context.tsx"),
        replacement: resolve(currentDir, "./mocks/auth-context"),
      },
      {
        find: resolve(currentDir, "../lib/account-erasure-storage"),
        replacement: resolve(currentDir, "./mocks/account-erasure-storage"),
      },
      {
        find: resolve(currentDir, "../lib/mobile-account-purge"),
        replacement: resolve(currentDir, "./mocks/mobile-account-purge"),
      },
    ];
    viteConfig.plugins.push({
      name: "storybook-health-kit-module-mock",
      enforce: "pre",
      resolveId(source, importer) {
        if (
          (source === "./src/HealthKitModule" || source === "./src/HealthKitModule.ts") &&
          importer?.endsWith("/modules/health-kit/index.ts")
        ) {
          return resolve(currentDir, "./mocks/HealthKitModule.ts");
        }
        return null;
      },
    });
    return viteConfig;
  },
};

export default config;
