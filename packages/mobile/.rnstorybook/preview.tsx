import type { Preview } from "@storybook/react-native";
import { type PropsWithChildren, useEffect } from "react";
import { Appearance, View } from "react-native";
import { colors } from "../theme";

function AppearancePreview({
  appearance,
  children,
}: PropsWithChildren<{ appearance: "light" | "dark" }>) {
  useEffect(() => {
    Appearance.setColorScheme(appearance);
    return () => Appearance.setColorScheme(null);
  }, [appearance]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, padding: 16 }}>{children}</View>
  );
}

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const appearance = context.globals.appearance === "dark" ? "dark" : "light";
      return (
        <AppearancePreview appearance={appearance}>
          <Story />
        </AppearancePreview>
      );
    },
  ],
  globalTypes: {
    appearance: {
      description: "iOS system appearance",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    appearance: "light",
  },
  parameters: {
    controls: {
      expanded: true,
    },
  },
};

export default preview;
