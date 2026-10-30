import type { UnhandledFrameHandle } from "msw";
import { HttpNetworkFrame } from "msw/experimental";

function isLocalRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * Fail fast on unexpected external requests while allowing local test
 * infrastructure traffic like Docker/Testcontainers and local app probes.
 */
export const failOnUnhandledExternalRequest: UnhandledFrameHandle = ({ frame, defaults }) => {
  if (!(frame instanceof HttpNetworkFrame) || isLocalRequest(frame.data.request)) {
    return;
  }

  defaults.error();
  throw Response.error();
};
