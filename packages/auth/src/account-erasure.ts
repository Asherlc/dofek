import { z } from "zod";

export const AccountErasureBearerCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const timestampSchema = z.iso.datetime({ offset: true });

export const AccountErasureStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_replay",
  "waiting_retention",
  "failed",
  "completed",
]);

const accountErasurePreparationCapabilityBaseSchema = z.object({
  expiresAt: timestampSchema,
  preparationToken: AccountErasureBearerCapabilitySchema,
});

export const AccountErasureUnattemptedPreparationCapabilitySchema =
  accountErasurePreparationCapabilityBaseSchema
    .extend({
      ownerUserId: z.string().min(1),
    })
    .strict();

export const AccountErasureAttemptedPreparationCapabilitySchema =
  accountErasurePreparationCapabilityBaseSchema
    .extend({
      cleanupOwnerNonce: z.uuid(),
      confirmationAttemptedAt: timestampSchema,
    })
    .strict();

export const AccountErasurePreparationCapabilitySchema = z.union([
  AccountErasureUnattemptedPreparationCapabilitySchema,
  AccountErasureAttemptedPreparationCapabilitySchema,
]);

export const AccountErasureStatusCapabilitySchema = z.object({
  cleanupOwnerNonce: z.uuid(),
  localCleanupGeneration: z.uuid().optional(),
  localCleanupBlockedByAnotherSession: z.boolean().optional(),
  localCleanupPending: z.boolean().optional(),
  requestId: z.uuid(),
  statusToken: AccountErasureBearerCapabilitySchema,
});

export const ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE =
  "Local account deletion cleanup stopped because another account became active. Sign out of that account before retrying cleanup.";

export function accountErasureCleanupWasBlocked(errors: readonly Error[]): boolean {
  return errors.some((error) => error.message === ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE);
}

export const PublicAccountErasureStatusSchema = z.object({
  completedAt: timestampSchema.nullable(),
  currentPhase: z.string().nullable(),
  deadlineMissed: z.boolean(),
  id: z.uuid(),
  message: z.string().nullable(),
  replayRetainedUntil: timestampSchema,
  requestedAt: timestampSchema,
  retentionUntil: timestampSchema,
  status: AccountErasureStatusSchema,
});

export type AccountErasurePreparationCapability = z.infer<
  typeof AccountErasurePreparationCapabilitySchema
>;
export type AccountErasureAttemptedPreparationCapability = z.infer<
  typeof AccountErasureAttemptedPreparationCapabilitySchema
>;
export type AccountErasureUnattemptedPreparationCapability = z.infer<
  typeof AccountErasureUnattemptedPreparationCapabilitySchema
>;
export type AccountErasureStatusCapability = z.infer<typeof AccountErasureStatusCapabilitySchema>;
export type PublicAccountErasureStatus = z.infer<typeof PublicAccountErasureStatusSchema>;

export interface AccountErasureStatusPresentation {
  detail: string;
  isComplete: boolean;
  title: string;
  tone: "danger" | "progress" | "success";
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
});
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatBoundary(value: string): string {
  return dateFormatter.format(new Date(value));
}

function formatCompletion(value: string): string {
  return `${dateTimeFormatter.format(new Date(value))} UTC`;
}

export function describeAccountErasureStatus(
  status: PublicAccountErasureStatus,
): AccountErasureStatusPresentation {
  const replayBoundary = formatBoundary(status.replayRetainedUntil);
  const retentionBoundary = formatBoundary(status.retentionUntil);
  const overdueStatus = status.deadlineMissed && status.message ? `${status.message} ` : "";

  switch (status.status) {
    case "pending":
      return {
        title: "Deletion request accepted",
        detail: `${overdueStatus}Dofek has blocked new account activity and queued deletion. If a target date is missed, deletion continues automatically.`,
        isComplete: false,
        tone: "progress",
      };
    case "running":
      return {
        title: "Deletion in progress",
        detail: `${status.message ?? "Dofek is deleting active application data."} If a target date is missed, deletion continues automatically.`,
        isComplete: false,
        tone: "progress",
      };
    case "waiting_replay":
      return {
        title: "Waiting for active-store verification",
        detail: `${overdueStatus}Deletion remains in progress while late events are fenced through ${replayBoundary}. Dofek will then verify its active application stores. If that date is missed, deletion continues automatically.`,
        isComplete: false,
        tone: "progress",
      };
    case "waiting_retention":
      return {
        title: "Active application stores verified",
        detail: `${overdueStatus}Dofek's active application stores were verified after the replay window ending ${replayBoundary}. Deletion is still in progress while processor records, observability logs and backups age out. Final verification is due by ${retentionBoundary}; if that date is missed, deletion continues automatically.`,
        isComplete: false,
        tone: "progress",
      };
    case "failed":
      return {
        title: "Deletion needs attention",
        detail: `${status.message ?? "Dofek could not finish the current deletion step."} Deletion continues automatically when the request is retryable; contact support with the request ID if this page asks for assistance.`,
        isComplete: false,
        tone: "danger",
      };
    case "completed":
      if (!status.completedAt) {
        return {
          title: "Deletion verified",
          detail: "Dofek completed final retained-data verification.",
          isComplete: true,
          tone: "success",
        };
      }
      return {
        title: "Deletion verified",
        detail: status.deadlineMissed
          ? `Dofek completed final retained-data verification on ${formatCompletion(status.completedAt)}, after the ${retentionBoundary} deadline.`
          : `Dofek completed final retained-data verification on ${formatCompletion(status.completedAt)}, before the ${retentionBoundary} deadline.`,
        isComplete: true,
        tone: "success",
      };
  }
}
