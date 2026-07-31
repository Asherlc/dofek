import { queryCache } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { logger } from "../logger.ts";

export async function invalidateNutritionCaches(userId: string): Promise<void> {
  const results = await Promise.allSettled([
    queryCache.invalidateByPrefix(`${userId}:food.`),
    queryCache.invalidateByPrefix(`${userId}:nutrition.`),
    queryCache.invalidateByPrefix(`${userId}:nutritionAnalytics.`),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn(
        `[nutrition] Failed to invalidate nutrition cache for userId=${userId}: ${result.reason}`,
      );
      captureException(result.reason);
    }
  }
}
