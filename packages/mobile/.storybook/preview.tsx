import type { Preview } from "@storybook/react-native-web-vite";
import { View } from "react-native";

const preview: Preview = {
  decorators: [
    (Story) => (
      <View style={{ flex: 1, backgroundColor: "#eef3ed", padding: 16 }}>
        <Story />
      </View>
    ),
  ],
  parameters: {
    layout: "centered",
    controls: {
      expanded: true,
    },
  },
};

export default preview;
