import {
  createRateLimitAwareFetch,
  type RateLimitAwareFetchOptions,
} from "@dofek/provider-http/rate-limit";
import { providerAdaptiveRateLimitStore } from "./provider-adaptive-rate-limit.ts";
import { recordProviderHttpTimeout, reportProviderHttpDiagnostic } from "./provider-diagnostics.ts";

export function createProviderRateLimitFetch(
  providerId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  options?: Omit<RateLimitAwareFetchOptions, "providerId" | "adaptiveStore" | "onRequestTimeout">,
): typeof globalThis.fetch {
  return createRateLimitAwareFetch(fetchFn, {
    providerId,
    adaptiveStore: providerAdaptiveRateLimitStore,
    ...options,
    onRequestTimeout: (error) => recordProviderHttpTimeout(error.providerId),
    onResponse: async (response, input, init, requestStartedAtMs) => {
      await reportProviderHttpDiagnostic(
        providerId,
        response,
        input,
        init,
        options?.userId,
        requestStartedAtMs,
      );
      await options?.onResponse?.(response, input, init, requestStartedAtMs);
    },
  });
}
