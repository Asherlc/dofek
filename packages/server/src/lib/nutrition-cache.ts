import * as Sentry from "@sentry/node";
import { queryCache } from "dofek/lib/cache";
import { logger } from "../logger.ts";

export async function invalidateNutritionCaches(userId: string): Promise<void> {
  const results = await Promise.allSettled([
    queryCache.invalidateByPrefix(`${userId}:food.`),
    queryCache.invalidateByPrefix(`${userId}:nutrition.`),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn(
        `[nutrition] Failed to invalidate nutrition cache for userId=${userId}: ${result.reason}`,
      );
      Sentry.captureException(result.reason);
    }
  }
}
