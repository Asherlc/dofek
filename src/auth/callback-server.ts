import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generate a self-signed cert for localhost. Returns key + cert PEM strings.
 */
function generateSelfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "health-data-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );

  const key = readFileSync(keyPath, "utf-8");
  const cert = readFileSync(certPath, "utf-8");
  rmSync(dir, { recursive: true });
  return { key, cert };
}

/**
 * Starts a temporary HTTPS server to receive the OAuth callback.
 * Falls back to HTTP if the redirect URI is not https.
 * Returns a promise that resolves with the authorization code.
 */
export function waitForAuthCode(
  port: number,
  options: { https?: boolean; paramName?: string } = {},
): Promise<{ code: string; cleanup: () => void }> {
  const useHttps = options.https ?? true;
  const paramName = options.paramName ?? "code";

  return new Promise((resolve, reject) => {
    const handler = (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => {
      const proto = useHttps ? "https" : "http";
      // Stryker disable next-line all — defensive fallback for req.url; always present in practice
      const url = new URL(req.url ?? "/", `${proto}://localhost:${port}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get(paramName);
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
    };

    let server: Server;
    if (useHttps) {
      const { key, cert } = generateSelfSignedCert();
      server = createHttpsServer({ key, cert }, handler);
    } else {
      server = createHttpServer(handler);
    }

    const proto = useHttps ? "https" : "http";
    server.listen(port, () => {
      console.log(`[auth] Callback server listening on ${proto}://localhost:${port}/callback`);
      if (useHttps) {
        console.log("[auth] Using self-signed cert — accept the browser warning to complete auth.");
      }
    });

    server.on("error", reject);
  });
}
