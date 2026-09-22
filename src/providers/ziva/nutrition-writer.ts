import { eq } from "drizzle-orm";
import type { Database, SyncDatabase } from "../../db/index.ts";
import { foodEntry, foodEntryNutrient } from "../../db/schema/nutrition.ts";
import type { NormalizedZivaMeal } from "./schemas.ts";

type TransactionalSyncDatabase = SyncDatabase & Pick<Database, "transaction">;

function hasTransaction(db: SyncDatabase): db is TransactionalSyncDatabase {
  return "transaction" in db && typeof db.transaction === "function";
}

function requireTransactionalDatabase(db: SyncDatabase): TransactionalSyncDatabase {
  if (!hasTransaction(db)) {
    throw new Error("Ziva nutrition sync requires a transactional database");
  }
  return db;
}

export async function upsertZivaMealsForDate(
  db: SyncDatabase,
  userId: string,
  meals: NormalizedZivaMeal[],
): Promise<number> {
  const transactionalDb = requireTransactionalDatabase(db);

  return transactionalDb.transaction(async (transaction) => {
    for (const meal of meals) {
      const [row] = await transaction
        .insert(foodEntry)
        .values({
          userId,
          providerId: "ziva",
          externalId: meal.externalId,
          sourceAccountKey: meal.sourceAccountKey,
          date: meal.date,
          nutritionGrain: "meal_aggregate",
          meal: meal.meal,
          foodName: meal.foodName,
          foodDescription: meal.foodDescription,
          numberOfUnits: meal.numberOfUnits,
          servingUnit: meal.servingUnit,
          servingWeightGrams: meal.servingWeightGrams,
          loggedAt: meal.loggedAt,
          sourceName: "Ziva",
          raw: meal.raw,
          confirmed: true,
        })
        .onConflictDoUpdate({
          target: [foodEntry.userId, foodEntry.providerId, foodEntry.externalId],
          set: {
            sourceAccountKey: meal.sourceAccountKey,
            date: meal.date,
            nutritionGrain: "meal_aggregate",
            meal: meal.meal,
            foodName: meal.foodName,
            foodDescription: meal.foodDescription,
            numberOfUnits: meal.numberOfUnits,
            servingUnit: meal.servingUnit,
            servingWeightGrams: meal.servingWeightGrams,
            loggedAt: meal.loggedAt,
            sourceName: "Ziva",
            raw: meal.raw,
            confirmed: true,
          },
        })
        .returning({ id: foodEntry.id });
      if (!row) {
        throw new Error("Ziva food entry upsert did not return an ID");
      }

      await transaction.delete(foodEntryNutrient).where(eq(foodEntryNutrient.foodEntryId, row.id));
      if (meal.nutrients.length > 0) {
        await transaction.insert(foodEntryNutrient).values(
          meal.nutrients.map(({ nutrientId, amount }) => ({
            foodEntryId: row.id,
            nutrientId,
            amount,
          })),
        );
      }
    }

    return meals.length;
  });
}
