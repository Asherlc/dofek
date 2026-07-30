import type { Preview } from "@storybook/react-native-web-vite";
import { View } from "react-native";
import { colors } from "../theme";

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const isFullscreen = context.parameters.layout === "fullscreen";
      return (
        <View
          style={{
            flex: 1,
            backgroundColor: colors.background,
            ...(isFullscreen ? {} : { padding: 16 }),
          }}
        >
          <Story />
        </View>
      );
    },
  ],
  parameters: {
    layout: "centered",
    controls: {
      expanded: true,
    },
  },
};

export default preview;
