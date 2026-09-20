import { createHash } from "node:crypto";
import { z } from "zod";

type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";
type NutrientId = "calories" | "protein" | "carbohydrate" | "fat";

const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a non-blank string",
});
const nonnegativeFiniteNumberSchema = z.number().finite().nonnegative();
const diaryDateSchema = z.iso.date();
const sourceTimestampSchema = z.iso.datetime({ offset: true, local: true });
const zonedTimestampSchema = z.iso.datetime({ offset: true });

const zivaMealItemSchema = z
  .object({
    food: nonBlankStringSchema,
    portion: nonBlankStringSchema,
    gramWeight: nonnegativeFiniteNumberSchema.nullable(),
    quantity: nonnegativeFiniteNumberSchema,
  })
  .passthrough();

const zivaMealMacrosSchema = z
  .object({
    protein: nonnegativeFiniteNumberSchema,
    fat: nonnegativeFiniteNumberSchema,
    carbs: nonnegativeFiniteNumberSchema,
    calories: nonnegativeFiniteNumberSchema,
  })
  .passthrough();

const zivaMealSchema = z
  .object({
    mealId: nonBlankStringSchema,
    description: nonBlankStringSchema,
    mealDate: diaryDateSchema,
    items: z.array(zivaMealItemSchema),
    macros: zivaMealMacrosSchema,
    itemCount: z.number().int().nonnegative(),
    mealType: nonBlankStringSchema,
    mealTime: nonBlankStringSchema.nullable(),
    createdAt: sourceTimestampSchema,
  })
  .passthrough()
  .superRefine((meal, context) => {
    if (meal.itemCount !== meal.items.length) {
      context.addIssue({
        code: "custom",
        path: ["itemCount"],
        message: "Ziva itemCount must match the items array length",
      });
    }
  });

const zivaMealPayloadSchema = z
  .object({
    meals: z.array(zivaMealSchema),
  })
  .passthrough();

export type ZivaMealPayload = z.infer<typeof zivaMealPayloadSchema>;

export interface NormalizedZivaMeal {
  externalId: string;
  sourceAccountKey: string;
  date: string;
  meal: MealType;
  foodName: string;
  foodDescription: string;
  numberOfUnits: number | null;
  servingUnit: string | null;
  servingWeightGrams: number | null;
  loggedAt: Date | null;
  raw: Record<string, unknown>;
  nutrients: Array<{
    nutrientId: NutrientId;
    amount: number;
  }>;
}

export function parseZivaMealPayload(
  value: unknown,
  options: { expectedDate: string },
): ZivaMealPayload {
  const expectedDate = diaryDateSchema.parse(options.expectedDate);
  return zivaMealPayloadSchema
    .superRefine((payload, context) => {
      const mealIds = new Set<string>();
      for (const [mealIndex, meal] of payload.meals.entries()) {
        if (meal.mealDate !== expectedDate) {
          context.addIssue({
            code: "custom",
            path: ["meals", mealIndex, "mealDate"],
            message: `Expected Ziva meal date ${expectedDate}`,
          });
        }
        if (mealIds.has(meal.mealId)) {
          context.addIssue({
            code: "custom",
            path: ["meals", mealIndex, "mealId"],
            message: "Ziva meal IDs must be unique within a response",
          });
        }
        mealIds.add(meal.mealId);
      }
    })
    .parse(value);
}

function normalizeMealType(mealType: string): MealType {
  const normalizedMealType = mealType.toLowerCase();
  if (
    normalizedMealType === "breakfast" ||
    normalizedMealType === "lunch" ||
    normalizedMealType === "dinner" ||
    normalizedMealType === "snack"
  ) {
    return normalizedMealType;
  }
  return "other";
}

function parseLoggedAt(createdAt: string): Date | null {
  if (!zonedTimestampSchema.safeParse(createdAt).success) return null;
  return new Date(createdAt);
}

export function normalizeZivaMeal(
  meal: ZivaMealPayload["meals"][number],
  identity: { userId: string; accountSubject: string },
): NormalizedZivaMeal {
  const sourceAccountKey = createHash("sha256")
    .update(`ziva\0${identity.userId}\0${identity.accountSubject}`)
    .digest("hex");
  const externalId = `meal:${createHash("sha256")
    .update(`${sourceAccountKey}\0${meal.mealId}`)
    .digest("hex")}`;
  const singletonItem = meal.items.length === 1 ? meal.items[0] : undefined;

  return {
    externalId,
    sourceAccountKey,
    date: meal.mealDate,
    meal: normalizeMealType(meal.mealType),
    foodName: singletonItem?.food ?? meal.description,
    foodDescription: meal.description,
    numberOfUnits: singletonItem?.quantity ?? null,
    servingUnit: singletonItem?.portion ?? null,
    servingWeightGrams: singletonItem ? singletonItem.gramWeight : null,
    loggedAt: parseLoggedAt(meal.createdAt),
    raw: meal,
    nutrients: [
      { nutrientId: "calories", amount: meal.macros.calories },
      { nutrientId: "protein", amount: meal.macros.protein },
      { nutrientId: "carbohydrate", amount: meal.macros.carbs },
      { nutrientId: "fat", amount: meal.macros.fat },
    ],
  };
}
