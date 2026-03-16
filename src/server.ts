import { createServer } from "node:http";
import { createDatabaseFromEnv } from "./db/index.ts";
import { importAppleHealthFile } from "./providers/apple-health.ts";
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
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Upload endpoint: POST /upload/apple-health`);
  if (API_KEY) {
    console.log("[server] API key auth enabled");
  } else {
    console.log("[server] WARNING: No UPLOAD_API_KEY set — endpoint is unauthenticated");
  }
});
