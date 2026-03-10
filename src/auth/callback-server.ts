import { createServer, type Server } from "node:http";

/**
 * Starts a temporary HTTP server to receive the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
export function waitForAuthCode(port: number): Promise<{ code: string; cleanup: () => void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          reject(new Error(`OAuth authorization denied: ${error}`));
          server.close();
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Authorized!</h1><p>You can close this tab and return to the terminal.</p>");
          resolve({ code, cleanup: () => server.close() });
          return;
        }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(port, () => {
      console.log(`[auth] Callback server listening on http://localhost:${port}/callback`);
    });

    server.on("error", reject);
  });
}
