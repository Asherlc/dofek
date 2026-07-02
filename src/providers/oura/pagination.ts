import { fetchProviderPages } from "../../sync/pagination.ts";
import type { SyncDegradation } from "../../sync/sync-degradation.ts";
import { OuraApiError } from "./client.ts";
import type { OuraListResponse } from "./schemas.ts";

export interface OuraPagesResult<T> {
  items: T[];
  degradations: SyncDegradation[];
}

function isOuraOptionalScopeError(err: unknown): boolean {
  return err instanceof OuraApiError && err.status === 401;
}

export async function fetchOuraPages<T>(
  providerId: string,
  stepName: string,
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
): Promise<OuraPagesResult<T>> {
  const result = await fetchProviderPages({
    providerId,
    stepName,
    fetchPage: async (cursor) => {
      const response = await fetchPage(cursor);
      return {
        items: response.data,
        nextCursor: response.next_token || null,
      };
    },
  });

  return { items: result.items, degradations: result.degradations };
}

export async function fetchOuraPagesOptional<T>(
  providerId: string,
  stepName: string,
  fetchPage: (nextToken?: string) => Promise<OuraListResponse<T>>,
): Promise<OuraPagesResult<T>> {
  try {
    return await fetchOuraPages(providerId, stepName, fetchPage);
  } catch (err) {
    if (isOuraOptionalScopeError(err)) {
      return {
        items: [],
        degradations: [
          {
            kind: "optional_endpoint_unavailable",
            providerId,
            stepName,
            message: `Missing OAuth scope for ${stepName}`,
          },
        ],
      };
    }
    throw err;
  }
}

export const HEALTH_EVENT_BATCH_SIZE = 1000;
