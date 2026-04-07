import { createServer } from "node:http";
import { createDatabaseFromEnv } from "./db/index.ts";
import { logger } from "./logger.ts";
import { importAppleHealthFile } from "./providers/apple-health/import.ts";
import { createUploadHandler } from "./upload-server.ts";

const PORT = parseInt(process.env.UPLOAD_PORT ?? "9877", 10);
const API_KEY = process.env.UPLOAD_API_KEY;

const handler = createUploadHandler({
  createDatabase: createDatabaseFromEnv,
  importAppleHealth: importAppleHealthFile,
  apiKey: API_KEY,
});

const server = createServer(handler);

server.listen(PORT, () => {
  logger.info(`[server] Listening on port ${PORT}`);
  logger.info(`[server] Upload endpoint: POST /upload/apple-health`);
  if (API_KEY) {
    logger.info("[server] API key auth enabled");
  } else {
    logger.info("[server] WARNING: No UPLOAD_API_KEY set — endpoint is unauthenticated");
  }
});
