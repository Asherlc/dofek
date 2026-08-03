import type { PublicAccountErasureStatus } from "@dofek/auth/account-erasure";
import type { Meta, StoryObj } from "@storybook/react-native";
import { AccountDeletionStatusView } from "./AccountDeletionStatusScreen";

const capability = {
  cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
  requestId: "11111111-1111-4111-8111-111111111111",
  statusToken: "s".repeat(43),
};

const waitingRetentionStatus: PublicAccountErasureStatus = {
  completedAt: null,
  currentPhase: "processor_log_backup_retention",
  deadlineMissed: false,
  id: capability.requestId,
  message: "Active application stores are verified.",
  replayRetainedUntil: "2026-08-02T12:00:00.000Z",
  requestedAt: "2026-07-26T12:00:00.000Z",
  retentionUntil: "2026-08-25T12:00:00.000Z",
  status: "waiting_retention",
};

const meta = {
  title: "Pages/Account Deletion Status",
  component: AccountDeletionStatusView,
  args: {
    capability,
    error: null,
    isLoading: false,
    localCleanupPending: false,
    onForget: () => undefined,
    onRefresh: () => undefined,
    onSignIn: () => undefined,
    status: waitingRetentionStatus,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AccountDeletionStatusView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    capability: null,
    status: null,
  },
};

export const Loading: Story = {
  args: {
    capability,
    isLoading: true,
    status: null,
  },
};

export const ErrorState: Story = {
  name: "Error",
  args: {
    capability,
    error: "Deletion status could not be loaded. Check your connection and try again.",
    status: null,
  },
};

export const Retention: Story = {};

export const Success: Story = {
  args: {
    status: {
      ...waitingRetentionStatus,
      completedAt: "2026-08-24T12:00:00.000Z",
      currentPhase: "completed",
      message: "Final verification completed.",
      status: "completed",
    },
  },
};
