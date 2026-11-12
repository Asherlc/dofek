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
    isRequestingPermissions: false,
    permissionMessage: null,
    syncMessage: null,
    syncProgress: null,
    syncDateRange: null,
    shouldShowFullSync: true,
    shouldShowAppleHealthPermissionBanner: false,
    shouldShowAppleHealthClinicalRecords: false,
    shouldShowClinicalRecordsLink: false,
    onPrimaryAction: () => {},
    onReviewPermissions: () => {},
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

export const AppleHealthSyncing: Story = {
  args: {
    isSyncing: true,
    syncMessage: "Pushing 27 samples...",
    shouldShowAppleHealthPermissionBanner: true,
  },
};

export const AppleHealthReviewingPermissions: Story = {
  args: {
    ...AppleHealthSyncing.args,
    isRequestingPermissions: true,
    permissionMessage: "Requesting permissions...",
  },
};

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

export const GarminConnect: Story = {
  args: { primaryActionLabel: "Connect", shouldShowFullSync: false },
};

export const GarminReconnect: Story = {
  args: { primaryActionLabel: "Reconnect", shouldShowFullSync: false },
};
