import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE,
  AccountErasureBearerCapabilitySchema,
  AccountErasurePreparationCapabilitySchema,
  AccountErasureStatusCapabilitySchema,
  accountErasureCleanupWasBlocked,
  describeAccountErasureStatus,
} from "./account-erasure";

describe("account-erasure capabilities", () => {
  it("recognizes cleanup failures caused by another active account", () => {
    expect(
      accountErasureCleanupWasBlocked([
        new Error("unrelated cleanup error"),
        new Error(ACCOUNT_ERASURE_CLEANUP_OWNERSHIP_ERROR_MESSAGE),
      ]),
    ).toBe(true);
    expect(accountErasureCleanupWasBlocked([])).toBe(false);
    expect(accountErasureCleanupWasBlocked([new Error("unrelated cleanup error")])).toBe(false);
  });

  it("accepts only canonical 43-character bearer capabilities", () => {
    expect(AccountErasureBearerCapabilitySchema.safeParse("s".repeat(43)).success).toBe(true);
    expect(AccountErasureBearerCapabilitySchema.safeParse("s".repeat(42)).success).toBe(false);
    expect(AccountErasureBearerCapabilitySchema.safeParse("s".repeat(44)).success).toBe(false);
    expect(AccountErasureBearerCapabilitySchema.safeParse(`${"s".repeat(42)}+`).success).toBe(
      false,
    );
  });

  it("requires an owner when persisting a preparation capability", () => {
    expect(
      AccountErasurePreparationCapabilitySchema.safeParse({
        preparationToken: "p".repeat(43),
        expiresAt: "2026-07-26T12:15:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("replaces the raw owner with an opaque cleanup nonce after confirmation is attempted", () => {
    const attempted = AccountErasurePreparationCapabilitySchema.parse({
      cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });

    expect(attempted).not.toHaveProperty("ownerUserId");
    expect(
      AccountErasurePreparationCapabilitySchema.safeParse({
        ...attempted,
        ownerUserId: "user-1",
      }).success,
    ).toBe(false);
  });

  it("persists only the public request capability after confirmation", () => {
    expect(
      AccountErasureStatusCapabilitySchema.parse({
        cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
        localCleanupPending: true,
        requestId: "11111111-1111-4111-8111-111111111111",
        statusToken: "s".repeat(43),
      }),
    ).toEqual({
      cleanupOwnerNonce: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
      localCleanupPending: true,
    });
  });
});

describe("describeAccountErasureStatus", () => {
  it("describes a running deletion with its current message", () => {
    const presentation = describeAccountErasureStatus({
      completedAt: null,
      currentPhase: "delete_profile",
      deadlineMissed: false,
      id: "11111111-1111-4111-8111-111111111111",
      message: "Deleting profile data.",
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestedAt: "2026-07-26T12:00:00.000Z",
      retentionUntil: "2026-08-25T12:00:00.000Z",
      status: "running",
    });

    expect(presentation).toEqual({
      detail:
        "Deleting profile data. If a target date is missed, deletion continues automatically.",
      isComplete: false,
      title: "Deletion in progress",
      tone: "progress",
    });
  });

  it("uses safe defaults when running or failing status messages are absent", () => {
    const baseStatus = {
      completedAt: null,
      currentPhase: null,
      deadlineMissed: false,
      id: "11111111-1111-4111-8111-111111111111",
      message: null,
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestedAt: "2026-07-26T12:00:00.000Z",
      retentionUntil: "2026-08-25T12:00:00.000Z",
    } as const;

    expect(describeAccountErasureStatus({ ...baseStatus, status: "running" }).detail).toContain(
      "deleting active application data",
    );
    expect(describeAccountErasureStatus({ ...baseStatus, status: "failed" }).detail).toContain(
      "could not finish the current deletion step",
    );
  });

  it("describes a completed deletion without a completion timestamp", () => {
    const presentation = describeAccountErasureStatus({
      completedAt: null,
      currentPhase: "completed",
      deadlineMissed: false,
      id: "11111111-1111-4111-8111-111111111111",
      message: null,
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestedAt: "2026-07-26T12:00:00.000Z",
      retentionUntil: "2026-08-25T12:00:00.000Z",
      status: "completed",
    });

    expect(presentation).toEqual({
      detail: "Dofek completed final retained-data verification.",
      isComplete: true,
      title: "Deletion verified",
      tone: "success",
    });
  });

  it("distinguishes active-store verification from final retained-data verification", () => {
    const presentation = describeAccountErasureStatus({
      completedAt: null,
      currentPhase: "processor_log_backup_retention",
      deadlineMissed: false,
      id: "11111111-1111-4111-8111-111111111111",
      message: "Active application stores are verified.",
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestedAt: "2026-07-26T12:00:00.000Z",
      retentionUntil: "2026-08-25T12:00:00.000Z",
      status: "waiting_retention",
    });

    expect(presentation.title).toBe("Active application stores verified");
    expect(presentation.isComplete).toBe(false);
    expect(presentation.detail).toContain("August 2, 2026");
    expect(presentation.detail).toContain("August 25, 2026");
    expect(presentation.detail).toContain("logs and backups");
  });

  it("states that a missed deadline does not stop deletion", () => {
    const presentation = describeAccountErasureStatus({
      completedAt: null,
      currentPhase: "retrying",
      deadlineMissed: true,
      id: "11111111-1111-4111-8111-111111111111",
      message: "Deletion is retrying automatically.",
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestedAt: "2026-07-26T12:00:00.000Z",
      retentionUntil: "2026-08-25T12:00:00.000Z",
      status: "failed",
    });

    expect(presentation.detail).toContain("continues automatically");
    expect(presentation.isComplete).toBe(false);
  });

  it.each(["pending", "waiting_replay", "waiting_retention"] as const)(
    "preserves overdue support messaging while deletion is %s",
    (status) => {
      const presentation = describeAccountErasureStatus({
        completedAt: null,
        currentPhase: "retrying",
        deadlineMissed: true,
        id: "11111111-1111-4111-8111-111111111111",
        message:
          "Account deletion missed its 30-day deadline. Deletion remains active and automatic retries are continuing; support has been alerted.",
        replayRetainedUntil: "2026-08-02T12:00:00.000Z",
        requestedAt: "2026-07-26T12:00:00.000Z",
        retentionUntil: "2026-08-25T12:00:00.000Z",
        status,
      });

      expect(presentation.detail).toContain("missed its 30-day deadline");
      expect(presentation.detail).toContain("support has been alerted");
      expect(presentation.isComplete).toBe(false);
    },
  );

  it("reports the actual completion time when deletion finishes after its deadline", () => {
    const presentation = describeAccountErasureStatus({
      completedAt: "2026-08-26T12:34:00.000Z",
      currentPhase: "completed",
      deadlineMissed: true,
      id: "11111111-1111-4111-8111-111111111111",
      message: null,
      replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      requestedAt: "2026-07-26T12:00:00.000Z",
      retentionUntil: "2026-08-25T12:00:00.000Z",
      status: "completed",
    });

    expect(presentation.detail).toContain("August 26, 2026");
    expect(presentation.detail).toContain("12:34 PM");
    expect(presentation.detail).toContain("after the August 25, 2026 deadline");
    expect(presentation.isComplete).toBe(true);
  });
});
