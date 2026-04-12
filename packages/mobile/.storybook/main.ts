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
    const existingAliases =
      typeof viteConfig.resolve.alias === "object" && !Array.isArray(viteConfig.resolve.alias)
        ? viteConfig.resolve.alias
        : {};
    viteConfig.resolve.alias = {
      ...existingAliases,
      [resolve(currentDir, "../lib/auth-context")]: resolve(currentDir, "./mocks/auth-context"),
    };
    return viteConfig;
  },
};

export default config;
