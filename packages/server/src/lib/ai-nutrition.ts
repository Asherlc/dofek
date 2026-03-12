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

const mealValues = ["breakfast", "lunch", "dinner", "snack", "other"] as const;

/** Schema for multi-item nutrition analysis with meal detection */
const aiNutritionItemWithMealSchema = aiNutritionSchema.extend({
  meal: z.enum(mealValues).describe("The meal this food belongs to, inferred from context"),
});

export type NutritionItemWithMeal = z.infer<typeof aiNutritionItemWithMealSchema>;

const aiNutritionMultiSchema = z.object({
  items: z.array(aiNutritionItemWithMealSchema).min(1),
});

const SYSTEM_PROMPT = `You are a nutrition estimation expert. Given a natural language description of food, estimate the nutritional content as accurately as possible.

Guidelines:
- Estimate for a typical serving size unless the user specifies otherwise.
- When the description is vague (e.g. "a big plate"), estimate generously but realistically.
- Round calories to the nearest integer and macros to one decimal place.
- For mixed dishes, estimate the combined nutritional content as a single entry.
- Be conservative with calorie estimates — it's better to slightly overestimate than underestimate.
- Use your knowledge of USDA food composition data and common nutrition databases.`;

const MULTI_ITEM_SYSTEM_PROMPT = `You are a nutrition estimation expert. Given a natural language description of what someone ate, break it into individual food items and estimate the nutritional content of each.

Guidelines:
- Split distinct food items into separate entries (e.g. "a burrito and a coke" = 2 items).
- Do NOT split components of a single dish (e.g. "chicken stir fry with rice" = 1 item).
- Estimate for typical serving sizes unless specified otherwise.
- Infer the meal type (breakfast, lunch, dinner, snack) from context clues like time of day or explicit mentions. Default to "other" if unclear.
- Round calories to the nearest integer and macros to one decimal place.
- Be conservative with calorie estimates — slightly overestimate rather than underestimate.
- Use your knowledge of USDA food composition data.`;

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

export interface AnalyzeMultiResult {
  items: NutritionItemWithMeal[];
  provider: string;
}

/**
 * Analyze a food description and return multiple individual food items with meal detection.
 * Cascades through configured providers on rate limit errors.
 */
/**
 * Refine a previous nutrition analysis based on follow-up instructions.
 * Uses chat-style messages so the AI sees the original items as context.
 */
export async function refineNutritionItems(
  previousItems: NutritionItemWithMeal[],
  refinement: string,
): Promise<AnalyzeMultiResult> {
  const providers = getConfiguredProviders();

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured. Set at least one of: GEMINI_API_KEY, MISTRAL_API_KEY",
    );
  }

  const previousSummary = previousItems
    .map(
      (item) =>
        `- ${item.foodName} (${item.meal}): ${item.calories} cal, P:${item.proteinG}g C:${item.carbsG}g F:${item.fatG}g`,
    )
    .join("\n");

  let lastError: unknown;

  for (const provider of providers) {
    try {
      const result = await generateText({
        model: provider.createModel(),
        output: Output.object({ schema: aiNutritionMultiSchema }),
        system: `${MULTI_ITEM_SYSTEM_PROMPT}\n\nThe user is refining a previous analysis. Apply their corrections to the items and return the full updated list. If they say to remove an item, omit it. If they correct a quantity or add a new item, adjust accordingly.`,
        messages: [
          { role: "user", content: "Here's what I ate: the items below" },
          { role: "assistant", content: previousSummary },
          { role: "user", content: refinement },
        ],
      });

      if (!result.output) {
        throw new Error(`AI provider ${provider.name} returned no structured output`);
      }

      return {
        items: result.output.items,
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

export async function analyzeNutritionItems(description: string): Promise<AnalyzeMultiResult> {
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
        output: Output.object({ schema: aiNutritionMultiSchema }),
        system: MULTI_ITEM_SYSTEM_PROMPT,
        prompt: description,
      });

      if (!result.output) {
        throw new Error(`AI provider ${provider.name} returned no structured output`);
      }

      return {
        items: result.output.items,
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
