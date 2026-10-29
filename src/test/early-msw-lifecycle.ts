import { onUnhandledRequest, type RequestHandler, type UnhandledRequestStrategy } from "msw";
import { setupServer } from "msw/node";

// Cached provider clients and fixtures retain this same network across serial files.
// Only the setup file owns listen/close; fixtures select handlers and policy.
const server = setupServer();
let unhandledPolicy: UnhandledRequestStrategy = "bypass";

export function startEarlyMsw(): () => void {
  server.resetHandlers();
  unhandledPolicy = "bypass";
  server.listen({ onUnhandledRequest: (request) => onUnhandledRequest(request, unhandledPolicy) });
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
    activate(options: { onUnhandledRequest: UnhandledRequestStrategy }) {
      server.resetHandlers();
      server.use(...baselineHandlers);
      unhandledPolicy = options.onUnhandledRequest;
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
