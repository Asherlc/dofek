import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-native-web-vite";

const currentDir = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx)", "../app/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-native-web-vite",
  docs: {
    autodocs: "tag",
  },
  viteFinal: (viteConfig) => {
    viteConfig.resolve ??= {};
    viteConfig.plugins ??= [];
    const existingAliases =
      typeof viteConfig.resolve.alias === "object" && !Array.isArray(viteConfig.resolve.alias)
        ? viteConfig.resolve.alias
        : {};
    viteConfig.resolve.alias = {
      ...existingAliases,
      "expo-modules-core": resolve(currentDir, "./mocks/expo-modules-core.ts"),
      "expo-router": resolve(currentDir, "./mocks/expo-router.ts"),
      "expo-updates": resolve(currentDir, "./mocks/expo-updates.ts"),
      "react-native-maps": resolve(currentDir, "./mocks/react-native-maps.tsx"),
      "react-native-reanimated": resolve(currentDir, "./mocks/react-native-reanimated.tsx"),
      [resolve(currentDir, "../lib/auth-context")]: resolve(currentDir, "./mocks/auth-context"),
      [resolve(currentDir, "../lib/auth-context.tsx")]: resolve(currentDir, "./mocks/auth-context"),
    };
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
