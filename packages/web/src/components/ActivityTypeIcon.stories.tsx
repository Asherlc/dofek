import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivityTypeIcon } from "./ActivityTypeIcon.tsx";

const meta = {
  title: "Activities/ActivityTypeIcon",
  component: ActivityTypeIcon,
  args: { activityType: "cycling" },
} satisfies Meta<typeof ActivityTypeIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Card: Story = {};
export const Compact: Story = { args: { variant: "compact" } };
export const Plain: Story = { args: { variant: "plain" } };
export const StrengthTraining: Story = { args: { activityType: "strength_training" } };
export const Hangboarding: Story = { args: { activityType: "hangboard" } };
export const HangboardingCompact: Story = {
  args: { activityType: "hangboard", variant: "compact" },
};
export const HangboardingPlain: Story = { args: { activityType: "hangboard", variant: "plain" } };

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
    <div className="grid grid-cols-4 gap-4">
      {families.map((activityType) => (
        <div key={activityType} className="flex flex-col items-center gap-2">
          <ActivityTypeIcon activityType={activityType} variant="plain" />
          <span className="text-xs">{activityType}</span>
        </div>
      ))}
    </div>
  ),
};

export const CompactThemes: Story = {
  render: () => (
    <div className="space-y-4">
      {[
        { background: "#f5f9f5", color: "#3f6240" },
        { background: "#18241c", color: "#f1f7f2" },
      ].map((theme) => (
        <div
          key={theme.background}
          className="flex flex-wrap gap-2 rounded-lg p-4"
          style={{ background: theme.background }}
        >
          {families.map((activityType) => (
            <ActivityTypeIcon
              key={activityType}
              activityType={activityType}
              variant="plain"
              color={theme.color}
            />
          ))}
        </div>
      ))}
    </div>
  ),
};
