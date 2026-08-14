import type { PublicAccountErasureStatus } from "@dofek/auth/account-erasure";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AccountDeletionStatusView } from "./AccountDeletionStatusPage.tsx";

const capability = {
  cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
  requestId: "11111111-1111-4111-8111-111111111111",
  statusToken: "s".repeat(43),
};

const waitingRetention: PublicAccountErasureStatus = {
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
  title: "Pages/Account deletion status",
  component: AccountDeletionStatusView,
  args: {
    capability: null,
    error: null,
    isLoading: false,
    localCleanupPending: false,
    onForget: () => undefined,
    onRefresh: () => undefined,
    status: null,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AccountDeletionStatusView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Loading: Story = {
  args: { capability, isLoading: true },
};

export const ErrorState: Story = {
  name: "Error",
  args: {
    capability,
    error: "Deletion status is temporarily unavailable. Please check again.",
  },
};

export const RetentionInProgress: Story = {
  args: { capability, status: waitingRetention },
};

export const CleanupBlocked: Story = {
  args: {
    capability: { ...capability, localCleanupPending: true },
    localCleanupPending: true,
    onRetryLocalCleanup: () => undefined,
    status: waitingRetention,
  },
};

export const Success: Story = {
  args: {
    capability,
    status: {
      ...waitingRetention,
      completedAt: "2026-08-24T12:00:00.000Z",
      currentPhase: "completed",
      message: "Final retained-data verification completed.",
      status: "completed",
    },
  },
};
