import type { StorybookConfig } from "@storybook/react-native";

const config: StorybookConfig = {
  stories: ["../components/**/*.stories.?(ts|tsx|js|jsx)", "../app/**/*.stories.?(ts|tsx|js|jsx)"],
  addons: ["@storybook/addon-ondevice-actions", "@storybook/addon-ondevice-controls"],
};

export default config;
