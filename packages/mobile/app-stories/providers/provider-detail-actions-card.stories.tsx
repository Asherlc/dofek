import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ProviderDetailActionsCard } from "../../components/providers/provider-detail-actions-card";
import { colors } from "../../theme";

const meta = {
  title: "Providers/ProviderDetailActionsCard",
  component: ProviderDetailActionsCard,
  args: {
    primaryActionLabel: "Sync",
    isSyncing: false,
    syncMessage: null,
    syncProgress: null,
    syncDateRange: null,
    shouldShowFullSync: true,
    shouldShowAppleHealthPermissionBanner: false,
    shouldShowAppleHealthClinicalRecords: false,
    shouldShowClinicalRecordsLink: false,
    onPrimaryAction: () => {},
    onFullSync: () => {},
    onOpenClinicalRecords: () => {},
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: colors.background }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ProviderDetailActionsCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WhoopRange: Story = {
  args: {
    syncDateRange: {
      sinceDate: "2026-07-22",
      untilDate: "2026-07-29",
      onSinceDateChange: () => {},
      onUntilDateChange: () => {},
    },
    shouldShowFullSync: false,
  },
};

export const Syncing: Story = {
  args: {
    isSyncing: true,
    syncMessage: "Fetching WHOOP recovery data...",
    syncProgress: 45,
    syncDateRange: {
      sinceDate: "2026-07-22",
      untilDate: "2026-07-29",
      onSinceDateChange: () => {},
      onUntilDateChange: () => {},
    },
    shouldShowFullSync: false,
  },
};

export const InvalidRange: Story = {
  args: {
    syncMessage: '"From" date must be on or before "To" date',
    syncDateRange: {
      sinceDate: "2026-07-29",
      untilDate: "2026-07-22",
      onSinceDateChange: () => {},
      onUntilDateChange: () => {},
    },
    shouldShowFullSync: false,
  },
};
