import { logger } from "../../logger.ts";
import type { OuraListResponse } from "./schemas.ts";

async function fetchAllPages<T>(
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
): Promise<T[]> {
  const allData: T[] = [];
  let nextToken: string | undefined;

  do {
    const response = await fetchPage(nextToken);
    allData.push(...response.data);
    nextToken = response.next_token ?? undefined;
  } while (nextToken);

  return allData;
}

/**
 * Like fetchAllPages, but returns an empty array on 401 (missing OAuth scope).
 * Use for endpoints that require optional OAuth scopes (stress, heart_health).
 */
export async function fetchAllPagesOptional<T>(
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
  endpointName: string,
): Promise<T[]> {
  try {
    return await fetchAllPages(fetchPage);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("API error 401")) {
      logger.warn(`[oura] Skipping ${endpointName}: missing required OAuth scope`);
      return [];
    }
    throw err;
  }
}

export { fetchAllPages };

export const HEALTH_EVENT_BATCH_SIZE = 1000;
