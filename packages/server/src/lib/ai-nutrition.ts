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
  // Fat breakdown
  polyunsaturatedFatG: z.number().nonnegative().optional().describe("Polyunsaturated fat in grams"),
  monounsaturatedFatG: z.number().nonnegative().optional().describe("Monounsaturated fat in grams"),
  transFatG: z.number().nonnegative().optional().describe("Trans fat in grams"),
  cholesterolMg: z.number().nonnegative().optional().describe("Cholesterol in milligrams"),
  // Minerals
  potassiumMg: z.number().nonnegative().optional().describe("Potassium in milligrams"),
  calciumMg: z.number().nonnegative().optional().describe("Calcium in milligrams"),
  ironMg: z.number().nonnegative().optional().describe("Iron in milligrams"),
  magnesiumMg: z.number().nonnegative().optional().describe("Magnesium in milligrams"),
  zincMg: z.number().nonnegative().optional().describe("Zinc in milligrams"),
  seleniumMcg: z.number().nonnegative().optional().describe("Selenium in micrograms"),
  copperMg: z.number().nonnegative().optional().describe("Copper in milligrams"),
  manganeseMg: z.number().nonnegative().optional().describe("Manganese in milligrams"),
  chromiumMcg: z.number().nonnegative().optional().describe("Chromium in micrograms"),
  iodineMcg: z.number().nonnegative().optional().describe("Iodine in micrograms"),
  // Vitamins
  vitaminAMcg: z.number().nonnegative().optional().describe("Vitamin A in micrograms RAE"),
  vitaminCMg: z.number().nonnegative().optional().describe("Vitamin C in milligrams"),
  vitaminDMcg: z.number().nonnegative().optional().describe("Vitamin D in micrograms"),
  vitaminEMg: z.number().nonnegative().optional().describe("Vitamin E in milligrams"),
  vitaminKMcg: z.number().nonnegative().optional().describe("Vitamin K in micrograms"),
  vitaminB1Mg: z.number().nonnegative().optional().describe("Thiamine (B1) in milligrams"),
  vitaminB2Mg: z.number().nonnegative().optional().describe("Riboflavin (B2) in milligrams"),
  vitaminB3Mg: z.number().nonnegative().optional().describe("Niacin (B3) in milligrams"),
  vitaminB5Mg: z.number().nonnegative().optional().describe("Pantothenic acid (B5) in milligrams"),
  vitaminB6Mg: z.number().nonnegative().optional().describe("Vitamin B6 in milligrams"),
  vitaminB7Mcg: z.number().nonnegative().optional().describe("Biotin (B7) in micrograms"),
  vitaminB9Mcg: z.number().nonnegative().optional().describe("Folate (B9) in micrograms DFE"),
  vitaminB12Mcg: z.number().nonnegative().optional().describe("Vitamin B12 in micrograms"),
  // Fatty acids
  omega3Mg: z.number().nonnegative().optional().describe("Omega-3 fatty acids in milligrams"),
  omega6Mg: z.number().nonnegative().optional().describe("Omega-6 fatty acids in milligrams"),
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

const SYSTEM_PROMPT = `You are a nutrition estimation expert. Given a natural language description of food, estimate the nutritional content as accurately as possible — including both macronutrients and micronutrients.

Guidelines:
- Estimate for a typical serving size unless the user specifies otherwise.
- When the description is vague (e.g. "a big plate"), estimate generously but realistically.
- Round calories to the nearest integer and macros to one decimal place.
- For mixed dishes, estimate the combined nutritional content as a single entry.
- Be conservative with calorie estimates — it's better to slightly overestimate than underestimate.
- Use your knowledge of USDA food composition data and common nutrition databases.
- Estimate all micronutrients (vitamins, minerals, omega fatty acids) you are confident about. Omit any you are unsure of rather than guessing wildly.`;

const MULTI_ITEM_SYSTEM_PROMPT = `You are a nutrition estimation expert. Given a natural language description of what someone ate, break it into individual food items and estimate the nutritional content of each — including both macronutrients and micronutrients.

Guidelines:
- Break everything into the most granular individual food items possible. Each distinct ingredient or food that could be tracked separately should be its own entry.
  - "two eggs and toast with butter" = 3 items: eggs, toast, butter.
  - "coffee with milk and sugar" = 3 items: coffee, milk, sugar.
  - "chicken salad with avocado and dressing" = 3 items: chicken salad, avocado, dressing.
- The only exception is a composed dish where the components are inseparable and always eaten together (e.g. "a burrito" = 1 item, "miso soup" = 1 item). If in doubt, split it.
- Estimate for typical serving sizes unless specified otherwise.
- Infer the meal type (breakfast, lunch, dinner, snack) from context clues like time of day or explicit mentions. Use the provided local time to guide your guess when the user doesn't specify. General guidelines: before 10am → breakfast, 10am–2pm → lunch, 5pm–9pm → dinner, otherwise → snack. Default to "other" only if truly ambiguous.
- Round calories to the nearest integer and macros to one decimal place.
- Be conservative with calorie estimates — slightly overestimate rather than underestimate.
- Use your knowledge of USDA food composition data.
- Estimate all micronutrients (vitamins, minerals, omega fatty acids) you are confident about. Omit any you are unsure of rather than guessing wildly.`;

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
  localTime?: string,
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
        system: `${MULTI_ITEM_SYSTEM_PROMPT}\n\nThe user is refining a previous analysis. Apply their corrections to the items and return the full updated list. If they say to remove an item, omit it. If they correct a quantity or add a new item, adjust accordingly.${localTime ? `\n\nThe user's local time is ${localTime}.` : ""}`,
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

export async function analyzeNutritionItems(
  description: string,
  localTime?: string,
): Promise<AnalyzeMultiResult> {
  const providers = getConfiguredProviders();

  if (providers.length === 0) {
    throw new Error(
      "No AI providers configured. Set at least one of: GEMINI_API_KEY, MISTRAL_API_KEY",
    );
  }

  let lastError: unknown;

  for (const provider of providers) {
    try {
      const system = localTime
        ? `${MULTI_ITEM_SYSTEM_PROMPT}\n\nThe user's local time is ${localTime}.`
        : MULTI_ITEM_SYSTEM_PROMPT;

      const result = await generateText({
        model: provider.createModel(),
        output: Output.object({ schema: aiNutritionMultiSchema }),
        system,
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
