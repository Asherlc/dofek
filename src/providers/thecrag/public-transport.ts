import {
  PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
  ProviderRequestTimeoutError,
} from "@dofek/provider-http/rate-limit";
import { Impit, TimeoutError } from "impit";
import { captureException } from "../../lib/error-reporting.ts";

export function createTheCragPublicFetch(): typeof globalThis.fetch {
  const client = new Impit({
    browser: "chrome",
    timeout: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
    followRedirects: false,
  });
  return async (input, init) => {
    const response = await client
      .fetch(input, {
        method: "GET",
        redirect: "manual",
        headers: new Headers(init?.headers),
        signal: init?.signal ?? undefined,
        timeout: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        if (!(error instanceof TimeoutError)) throw error;
        const timeout = new ProviderRequestTimeoutError({
          providerId: "thecrag",
          timeoutMs: PROVIDER_HTTP_REQUEST_TIMEOUT_MS,
        });
        captureException(timeout, { tags: { provider: "thecrag", phase: "public_request" } });
        throw timeout;
      });
    const normalized = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(normalized, "url", { value: response.url });
    Object.defineProperty(normalized, "redirected", { value: response.url !== String(input) });
    return normalized;
  };
}
