import {
  createRateLimitAwareFetch,
  type RateLimitAwareFetchOptions,
} from "@dofek/provider-http/rate-limit";
import { providerAdaptiveRateLimitStore } from "./provider-adaptive-rate-limit.ts";

export function createProviderRateLimitFetch(
  providerId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  options?: Omit<RateLimitAwareFetchOptions, "providerId" | "adaptiveStore">,
): typeof globalThis.fetch {
  return createRateLimitAwareFetch(fetchFn, {
    providerId,
    adaptiveStore: providerAdaptiveRateLimitStore,
    ...options,
  });
}
