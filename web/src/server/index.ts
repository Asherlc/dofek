import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { createDatabaseFromEnv } from "health-data/db";
import type { Context } from "../shared/trpc.js";
import { appRouter } from "./router.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const isDev = process.env.NODE_ENV !== "production";

async function main() {
  const app = express();
  const db = createDatabaseFromEnv();

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: (): Context => ({ db }),
    }),
  );

  if (isDev) {
    // In dev, use Vite's dev server as middleware
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: new URL("../../vite.config.ts", import.meta.url).pathname,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve the built client files
    const { default: path } = await import("node:path");
    const clientDir = path.resolve(import.meta.dirname, "../../dist/client");
    app.use(express.static(clientDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDir, "index.html"));
    });
  }

  app.listen(PORT, () => {
    console.log(`[web] Server running at http://localhost:${PORT}`);
    console.log(`[web] tRPC API at http://localhost:${PORT}/api/trpc`);
  });
}

main().catch((err) => {
  console.error("[web] Failed to start:", err);
  process.exit(1);
});
