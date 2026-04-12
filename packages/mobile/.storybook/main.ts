import type { StorybookConfig } from "@storybook/react-native-web-vite";

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx)", "../app/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-native-web-vite",
  docs: {
    autodocs: "tag",
  },
};

export default config;
