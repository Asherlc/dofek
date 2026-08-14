import { readFile } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

export function startStorybookStaticServer(
  rootDirectory: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      const requestedPath = pathname === "/" ? "/index.html" : pathname;
      const filePath = resolve(rootDirectory, `.${requestedPath}`);
      const relativeFilePath = relative(rootDirectory, filePath);
      if (
        relativeFilePath === ".." ||
        relativeFilePath.startsWith(`..${sep}`) ||
        isAbsolute(relativeFilePath)
      ) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      readFile(filePath, (error, file) => {
        if (error?.code === "ENOENT") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }
        if (error) {
          response.destroy(error);
          return;
        }
        response.writeHead(200, { "Content-Type": contentType(filePath) });
        response.end(file);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start static server"));
        return;
      }
      resolvePromise({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
