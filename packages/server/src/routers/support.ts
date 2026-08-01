import { TRPCError } from "@trpc/server";
import { userProfile } from "dofek/db/schema/reference";
import { captureException } from "dofek/lib/error-reporting";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  getPostHogConversationsClient,
  PostHogConversationsError,
} from "../lib/posthog-conversations.ts";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const createTicketInput = z.object({
  subject: z.string().trim().min(1, "Subject is required").max(255),
  message: z.string().trim().min(1, "Message is required").max(10_000),
  /** Optional reply-to email; falls back to the account's profile email. */
  email: z.string().email().optional(),
});

const createTicketOutput = z.object({
  ticketId: z.string().trim().min(1),
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

type SupportTicketErrorCode =
  | "BAD_GATEWAY"
  | "BAD_REQUEST"
  | "GATEWAY_TIMEOUT"
  | "SERVICE_UNAVAILABLE"
  | "TOO_MANY_REQUESTS"
  | "UNPROCESSABLE_CONTENT";

function mapPostHogError(error: unknown): {
  code: SupportTicketErrorCode;
  message: string;
} {
  if (!(error instanceof PostHogConversationsError)) {
    return {
      code: "BAD_GATEWAY",
      message: "PostHog Support Tickets is unavailable. Please try again shortly.",
    };
  }

  if (error.status === 401 || error.status === 403) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message:
        "Support Tickets could not authenticate this request. Please contact the administrator.",
    };
  }

  if (error.status === 422) {
    return {
      code: "UNPROCESSABLE_CONTENT",
      message: "Support Tickets rejected the request. Review your message and try again.",
    };
  }

  if (error.status === 429) {
    return {
      code: "TOO_MANY_REQUESTS",
      message: "Support Tickets is rate-limited. Please wait a moment before trying again.",
    };
  }

  if (error.status === 503) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message:
        "Support Tickets is not available for this project. Please contact the administrator.",
    };
  }

  if (error.status === 504) {
    return {
      code: "GATEWAY_TIMEOUT",
      message: "Support Tickets timed out. Please try again shortly.",
    };
  }

  if (error.status >= 400 && error.status < 500) {
    return {
      code: "BAD_REQUEST",
      message: "Support Tickets rejected the request. Review your message and try again.",
    };
  }

  return {
    code: "BAD_GATEWAY",
    message: "PostHog Support Tickets is unavailable. Please try again shortly.",
  };
}

export const supportRouter = router({
  createTicket: protectedProcedure
    .input(createTicketInput)
    .output(createTicketOutput)
    .mutation(async ({ ctx, input }) => {
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
        const mappedError = mapPostHogError(error);
        throw new TRPCError({
          code: mappedError.code,
          message: mappedError.message,
          cause: error,
        });
      }
    }),
});
