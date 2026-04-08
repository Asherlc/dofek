import type { UnhandledRequestCallback } from "msw";

function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * Fail fast on unexpected external requests while allowing local test
 * infrastructure traffic like Docker/Testcontainers and local app probes.
 */
export const failOnUnhandledExternalRequest: UnhandledRequestCallback = (request, print) => {
  if (isLocalRequest(request)) {
    return;
  }

  print.error();
};
