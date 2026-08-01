import { TRPCError } from "@trpc/server";
import { userProfile } from "dofek/db/schema/reference";
import { captureException } from "dofek/lib/error-reporting";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getPostHogConversationsClient } from "../lib/posthog-conversations.ts";
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
function buildDescription(
  subject: string,
  message: string,
  userId: string,
  appVersion?: string,
): string {
  return [
    `Subject: ${subject}`,
    "",
    message,
    "",
    "---",
    `User ID: ${userId}`,
    `App version: ${appVersion ?? "unknown"}`,
  ].join("\n");
}

export const supportRouter = router({
  createTicket: protectedProcedure.input(createTicketInput).mutation(async ({ ctx, input }) => {
    const [profile] = await ctx.db
      .select({ name: userProfile.name, email: userProfile.email })
      .from(userProfile)
      .where(eq(userProfile.id, ctx.userId))
      .limit(1);

    const contactEmail = input.email ?? profile?.email ?? undefined;
    if (!contactEmail) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "We need an email to reply to. Add an email to your profile or enter one above.",
      });
    }

    try {
      const ticket = await getPostHogConversationsClient().createTicket({
        message: buildDescription(input.subject, input.message, ctx.userId, ctx.appVersion),
        contactEmail,
        contactName: profile?.name ?? contactEmail,
        distinctId: ctx.userId,
        widgetSessionId: crypto.randomUUID(),
      });
      logger.info(`[support] ticket created userId=${ctx.userId} ticketId=${ticket.ticketId}`);
      return { ticketId: ticket.ticketId };
    } catch (error) {
      captureException(error);
      logger.error(
        `[support] ticket creation failed userId=${ctx.userId} message=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "PostHog Support Tickets is unavailable. Please try again shortly.",
        cause: error,
      });
    }
  }),
});
