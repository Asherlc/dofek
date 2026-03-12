import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { z } from "zod";

/** Schema for the nutrition breakdown returned by AI */
export const aiNutritionSchema = z.object({
  foodName: z.string().describe("A concise name for the food/meal described"),
  foodDescription: z
    .string()
    .describe("Brief serving description, e.g. '1 large plate, roughly 400g'"),
  category: z
    .enum([
      "beans_and_legumes",
      "beverages",
      "breads_and_cereals",
      "cheese_milk_and_dairy",
      "eggs",
      "fast_food",
      "fish_and_seafood",
      "fruit",
      "meat",
      "nuts_and_seeds",
      "pasta_rice_and_noodles",
      "salads",
      "sauces_spices_and_spreads",
      "snacks",
      "soups",
      "sweets_candy_and_desserts",
      "vegetables",
      "supplement",
      "other",
    ])
    .describe("Best-fit food category"),
  calories: z.number().int().nonnegative().describe("Total calories (kcal)"),
  proteinG: z.number().nonnegative().describe("Protein in grams"),
  carbsG: z.number().nonnegative().describe("Total carbohydrates in grams"),
  fatG: z.number().nonnegative().describe("Total fat in grams"),
  fiberG: z.number().nonnegative().describe("Dietary fiber in grams"),
  saturatedFatG: z.number().nonnegative().describe("Saturated fat in grams"),
  sugarG: z.number().nonnegative().describe("Sugar in grams"),
  sodiumMg: z.number().nonnegative().describe("Sodium in milligrams"),
});

export type AiNutritionResult = z.infer<typeof aiNutritionSchema>;

const SYSTEM_PROMPT = `You are a nutrition estimation expert. Given a natural language description of food, estimate the nutritional content as accurately as possible.

Guidelines:
- Estimate for a typical serving size unless the user specifies otherwise.
- When the description is vague (e.g. "a big plate"), estimate generously but realistically.
- Round calories to the nearest integer and macros to one decimal place.
- For mixed dishes, estimate the combined nutritional content as a single entry.
- Be conservative with calorie estimates — it's better to slightly overestimate than underestimate.
- Use your knowledge of USDA food composition data and common nutrition databases.`;

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

/** Rate limit errors that should trigger fallback to next provider */
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

export interface AnalyzeResult {
  nutrition: AiNutritionResult;
  provider: string;
}

/**
 * Analyze a food description using AI, cascading through configured providers
 * on rate limit errors: Gemini → Mistral.
 */
export async function analyzeNutrition(description: string): Promise<AnalyzeResult> {
  const providers = getConfiguredProviders();

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured. Set at least one of: GEMINI_API_KEY, MISTRAL_API_KEY",
    );
  }

  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await generateText({
        model: provider.createModel(),
        output: Output.object({ schema: aiNutritionSchema }),
        system: SYSTEM_PROMPT,
        prompt: description,
      });

      if (!result.output) {
        throw new Error(`AI provider ${provider.name} returned no structured output`);
      }

      return {
        nutrition: result.output,
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
