import path from "node:path";
import type { StorybookConfig } from "@storybook/react-native-web-vite";

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
      [path.resolve(__dirname, "../lib/auth-context")]: path.resolve(
        __dirname,
        "./mocks/auth-context",
      ),
    };
    return viteConfig;
  },
};

export default config;
