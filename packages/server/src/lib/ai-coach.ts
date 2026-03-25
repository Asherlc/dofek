import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { z } from "zod";

/** Context data provided to the AI coach for personalized advice */
export interface CoachContext {
  sleepHours?: number;
  sleepScore?: number;
  restingHr?: number;
  hrv?: number;
  strain?: number;
  readiness?: number;
  recentActivities?: string[];
  goals?: string;
}

/** Structured output schema for daily outlook */
export const dailyOutlookSchema = z.object({
  summary: z.string().describe("2-3 sentence personalized summary of today's outlook"),
  recommendations: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe("Actionable recommendations for the day"),
  focusArea: z
    .enum(["training", "recovery", "sleep", "nutrition", "stress-management"])
    .describe("Primary area to focus on today"),
});

export type DailyOutlook = z.infer<typeof dailyOutlookSchema>;

/** Chat message for the coach conversation */
export interface CoachMessage {
  role: "user" | "assistant";
  content: string;
}

const COACH_SYSTEM_PROMPT = `You are a personal health and fitness coach. You have access to the user's biometric data and activity history. Provide evidence-based, actionable advice.

Guidelines:
- Be encouraging but honest about areas that need improvement.
- Reference specific data points when making recommendations.
- Keep responses concise and practical.
- Focus on recovery, training load management, sleep optimization, and stress reduction.
- Never diagnose medical conditions or replace professional medical advice.
- Use plain language — avoid jargon and unexpanded acronyms.`;

const DAILY_OUTLOOK_SYSTEM_PROMPT = `${COACH_SYSTEM_PROMPT}

Generate a daily outlook based on the user's current metrics. Include:
1. A brief summary of their current state
2. 2-4 actionable recommendations
3. The primary area they should focus on today`;

/** Build the user prompt with available context data */
export function buildDailyOutlookPrompt(context: CoachContext): string {
  const parts: string[] = ["Here are my current health metrics:"];

  if (context.sleepHours != null) {
    parts.push(`- Sleep: ${context.sleepHours} hours last night`);
  }
  if (context.sleepScore != null) {
    parts.push(`- Sleep score: ${context.sleepScore}/100`);
  }
  if (context.restingHr != null) {
    parts.push(`- Resting heart rate: ${context.restingHr} bpm`);
  }
  if (context.hrv != null) {
    parts.push(`- Heart rate variability: ${context.hrv} ms`);
  }
  if (context.strain != null) {
    parts.push(`- Yesterday's strain: ${context.strain}/21`);
  }
  if (context.readiness != null) {
    parts.push(`- Readiness score: ${context.readiness}/100`);
  }
  if (context.recentActivities && context.recentActivities.length > 0) {
    parts.push(`- Recent activities: ${context.recentActivities.join(", ")}`);
  }
  if (context.goals) {
    parts.push(`- My goals: ${context.goals}`);
  }

  if (parts.length === 1) {
    parts.push("(No specific metrics available — give general wellness advice for today.)");
  }

  parts.push("\nWhat should I focus on today?");
  return parts.join("\n");
}

interface ProviderConfig {
  name: string;
  createModel: () => LanguageModel;
}

function getConfiguredProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  if (process.env.GEMINI_API_KEY) {
    providers.push({
      name: "gemini",
      createModel: () => {
        const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
        return google("gemini-2.5-flash");
      },
    });
  }

  if (process.env.MISTRAL_API_KEY) {
    providers.push({
      name: "mistral",
      createModel: () => {
        const mistral = createMistral({ apiKey: process.env.MISTRAL_API_KEY });
        return mistral("mistral-small-latest");
      },
    });
  }

  return providers;
}

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("rate limit") ||
      message.includes("quota") ||
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("resource_exhausted")
    );
  }
  return false;
}

export interface DailyOutlookResult {
  outlook: DailyOutlook;
  provider: string;
}

/**
 * Generate a daily outlook using AI, cascading through providers on rate limit.
 */
export async function generateDailyOutlook(context: CoachContext): Promise<DailyOutlookResult> {
  const providers = getConfiguredProviders();

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured. Set at least one of: GEMINI_API_KEY, MISTRAL_API_KEY",
    );
  }

  const prompt = buildDailyOutlookPrompt(context);
  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await generateText({
        model: provider.createModel(),
        output: Output.object({ schema: dailyOutlookSchema }),
        system: DAILY_OUTLOOK_SYSTEM_PROMPT,
        prompt,
      });

      if (!result.output) {
        throw new Error(`AI provider ${provider.name} returned no structured output`);
      }

      return {
        outlook: result.output,
        provider: provider.name,
      };
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `All AI providers rate-limited. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export interface ChatResult {
  response: string;
  provider: string;
}

/**
 * Chat with the AI coach, cascading through providers on rate limit.
 */
export async function chatWithCoach(
  messages: CoachMessage[],
  context: CoachContext,
): Promise<ChatResult> {
  const providers = getConfiguredProviders();

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured. Set at least one of: GEMINI_API_KEY, MISTRAL_API_KEY",
    );
  }

  const contextSummary = buildDailyOutlookPrompt(context);
  const systemPrompt = `${COACH_SYSTEM_PROMPT}\n\nUser's current metrics:\n${contextSummary}`;

  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await generateText({
        model: provider.createModel(),
        system: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      return {
        response: result.text,
        provider: provider.name,
      };
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `All AI providers rate-limited. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
