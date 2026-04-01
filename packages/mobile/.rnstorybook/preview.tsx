import type { Preview } from "@storybook/react-native";
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
    controls: {
      expanded: true,
    },
  },
};

export default preview;
