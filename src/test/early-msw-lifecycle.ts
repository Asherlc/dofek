import { isCommonAssetRequest, type RequestHandler, type UnhandledFrameHandle } from "msw";
import { HttpNetworkFrame } from "msw/experimental";
import { setupServer } from "msw/node";

// Cached provider clients and fixtures retain this same network across serial files.
// Only the setup file owns listen/close; fixtures select handlers and policy.
const server = setupServer();
let unhandledPolicy: UnhandledFrameHandle = "bypass";

export function startEarlyMsw(): () => void {
  server.resetHandlers();
  unhandledPolicy = "bypass";
  server.listen({
    onUnhandledFrame: async (args) => {
      if (!(args.frame instanceof HttpNetworkFrame)) return;
      if (typeof unhandledPolicy === "function") return unhandledPolicy(args);
      if (isCommonAssetRequest(args.frame.data.request)) return;
      if (unhandledPolicy === "warn") args.defaults.warn();
      if (unhandledPolicy === "error") {
        args.defaults.error();
        throw Response.error();
      }
    },
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    server.close();
    server.resetHandlers();
    unhandledPolicy = "bypass";
  };
}

/** Select one suite's handlers without creating another network interceptor. */
export function createIntegrationMswFixture(...baselineHandlers: RequestHandler[]) {
  return {
    activate(options: { onUnhandledFrame: UnhandledFrameHandle }) {
      server.resetHandlers();
      server.use(...baselineHandlers);
      unhandledPolicy = options.onUnhandledFrame;
    },
    deactivate() {
      server.resetHandlers();
      unhandledPolicy = "bypass";
    },
    use(...handlers: RequestHandler[]) {
      server.use(...handlers);
    },
    resetHandlers() {
      server.resetHandlers();
      server.use(...baselineHandlers);
    },
  };
}
