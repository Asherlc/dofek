import { setupServer } from "msw/node";

export function startEarlyMsw(): () => void {
  const server = setupServer();
  server.listen({ onUnhandledRequest: "bypass" });
  return () => server.close();
}
