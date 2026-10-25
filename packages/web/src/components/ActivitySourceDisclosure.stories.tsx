import type { ActivityOrigin } from "@dofek/providers/activity-origin";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure.tsx";

const origin: ActivityOrigin = {
  status: "resolved",
  memberActivityId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  sourceName: "Hang Ten",
};

const meta = {
  title: "Activities/ActivitySourceDisclosure",
  component: ActivitySourceDisclosure,
  args: { origin },
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="min-h-64 bg-page p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActivitySourceDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HangTenViaAppleHealth: Story = {};
export const StrongViaAppleHealth: Story = {
  args: { origin: { ...origin, sourceName: "Strong" } },
};
export const DirectWhoop: Story = {
  args: { origin: { ...origin, providerId: "whoop", sourceName: null } },
};
export const AppleHealthOnly: Story = { args: { origin: { ...origin, sourceName: null } } };
export const UnknownRecordingApp: Story = {
  args: { origin: { ...origin, sourceName: "My Workout App" } },
};
export const UnresolvedOrigin: Story = {
  args: { origin: { status: "unresolved", candidateMemberActivityIds: [] } },
};
