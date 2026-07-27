import * as Sentry from "@sentry/node";
import { TRPCError } from "@trpc/server";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { userProfile } from "dofek/db/schema/reference";
import { recordUserExternalEffect } from "dofek/db/user-external-effect";
import { getZohoDeskClient } from "dofek/zoho-desk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const createTicketInput = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(255),
  message: z.string().trim().min(1, "Message is required").max(10_000),
  /** Optional reply-to email; falls back to the account's profile email. */
  email: z.string().email().optional(),
});

/**
 * Build the ticket description sent to support agents. Includes the user's
 * message plus identifying context so agents can locate the account.
 */
function buildDescription(message: string, userId: string, appVersion?: string): string {
  return [message, "", "---", `User ID: ${userId}`, `App version: ${appVersion ?? "unknown"}`].join(
    "\n",
  );
}

function reportSupportFailure(operation: string): void {
  Sentry.captureException(new Error(`Support ${operation} failed`), {
    tags: { source: "support", operation },
  });
}

export const supportRouter = router({
  createTicket: protectedProcedure.input(createTicketInput).mutation(async ({ ctx, input }) => {
    const zohoDesk = getZohoDeskClient();
    let createdTicketId: string | null = null;
    try {
      return await withAccountErasureUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
        const [profile] = await transaction
          .select({ name: userProfile.name, email: userProfile.email })
          .from(userProfile)
          .where(eq(userProfile.id, ctx.userId))
          .limit(1);

        const contactEmail = input.email ?? profile?.email ?? undefined;
        if (!contactEmail) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "We need an email to reply to. Add an email to your profile or enter one above.",
          });
        }

        const ticket = await zohoDesk.createTicket({
          subject: input.subject,
          description: buildDescription(input.message, ctx.userId, ctx.appVersion),
          contactEmail,
          contactName: profile?.name ?? contactEmail,
        });
        createdTicketId = ticket.id;
        await recordUserExternalEffect(transaction, {
          system: "zoho_desk",
          resourceType: "ticket",
          externalId: ticket.id,
          userId: ctx.userId,
          contactEmail,
        });
        logger.info("[support] ticket created");
        return { ticketNumber: ticket.ticketNumber };
      });
    } catch (error: unknown) {
      if (createdTicketId) {
        try {
          await zohoDesk.deleteTicket(createdTicketId);
        } catch {
          reportSupportFailure("delete-orphan-ticket");
          logger.error("[support] orphan ticket cleanup failed");
        }
      }
      if (error instanceof AccountErasureUserFencedError) {
        logger.info("[support] ticket creation blocked by account deletion");
        throw new TRPCError({
          code: "CONFLICT",
          message: error.message,
        });
      }
      if (error instanceof TRPCError) throw error;
      reportSupportFailure("create-ticket");
      logger.error("[support] ticket creation failed");
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "We couldn't submit your request right now. Please try again shortly.",
        cause: error,
      });
    }
  }),
});
