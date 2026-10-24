import type { Meta, StoryObj } from "@storybook/react-native";
import { Text, View } from "react-native";
import { ActivityTypeIcon } from "./ActivityTypeIcon";

const meta = {
  title: "Activities/ActivityTypeIcon",
  component: ActivityTypeIcon,
  args: { activityType: "hangboard" },
} satisfies Meta<typeof ActivityTypeIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Hangboarding: Story = {};
export const Compact: Story = { args: { size: 32 } };
export const Running: Story = { args: { activityType: "running" } };
export const UnknownActivity: Story = { args: { activityType: "other" } };

const families = [
  "cycling",
  "running",
  "swimming",
  "walking",
  "strength",
  "yoga",
  "hiit",
  "elliptical",
  "rowing",
  "skiing",
  "climbing",
  "hangboard",
  "surfing",
  "soccer",
  "dance",
  "other",
];

export const CompleteFamily: Story = {
  render: () => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {families.map((activityType) => (
        <View key={activityType} style={{ alignItems: "center", width: 84 }}>
          <ActivityTypeIcon activityType={activityType} size={64} />
          <Text style={{ fontSize: 11 }}>{activityType}</Text>
        </View>
      ))}
    </View>
  ),
};

export const CompactThemes: Story = {
  render: () => (
    <View style={{ gap: 16 }}>
      {[
        { background: "#f5f9f5", color: "#3f6240" },
        { background: "#18241c", color: "#f1f7f2" },
      ].map((theme) => (
        <View
          key={theme.background}
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            padding: 12,
            backgroundColor: theme.background,
          }}
        >
          {families.map((activityType) => (
            <ActivityTypeIcon
              key={activityType}
              activityType={activityType}
              size={32}
              color={theme.color}
            />
          ))}
        </View>
      ))}
    </View>
  ),
};
