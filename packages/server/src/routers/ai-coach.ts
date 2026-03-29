import { z } from "zod";
import { type CoachMessage, chatWithCoach, generateDailyOutlook } from "../lib/ai-coach.ts";
import { AiCoachRepository } from "../repositories/ai-coach-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

export const aiCoachRouter = router({
  /**
   * Daily Outlook — AI-generated personalized daily summary and recommendations
   * based on recent sleep, vitals, and activity data.
   */
  dailyOutlook: cachedProtectedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const repo = new AiCoachRepository(ctx.db, ctx.userId);
    const context = await repo.fetchContext();
    const result = await generateDailyOutlook(context);

    return {
      summary: result.outlook.summary,
      recommendations: result.outlook.recommendations,
      focusArea: result.outlook.focusArea,
    };
  }),

  /**
   * Chat with the AI coach — send messages and get personalized responses
   * based on user's current health data.
   */
  chat: protectedProcedure
    .input(
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new AiCoachRepository(ctx.db, ctx.userId);
      const context = await repo.fetchContext();
      const coachMessages: CoachMessage[] = input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const result = await chatWithCoach(coachMessages, context);

      return {
        response: result.response,
      };
    }),
});
