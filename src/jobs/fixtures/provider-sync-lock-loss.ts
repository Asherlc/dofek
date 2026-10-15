import * as Sentry from "@sentry/node";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { z } from "zod";
import { createDatabase } from "../../db/index.ts";
import { initProductionSentry } from "../../lib/sentry.ts";
import { MountainProjectProvider } from "../../providers/mountain-project.ts";
import { SyncRun } from "../../providers/sync-run.ts";
import { SyncWindow } from "../../providers/sync-window.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import {
  createAccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "../account-erasure-work-guard.ts";

const input = z
  .object({ connectionString: z.string(), userId: z.string(), csv: z.string() })
  .parse(await new Promise<unknown>((resolve) => process.once("message", resolve)));

process.env.DEPLOY_ENVIRONMENT = "production";
initProductionSentry("https://test@sentry.example.test/1");
const transport = Sentry.getClient()?.getTransport();
if (!transport) throw new Error("Expected the production Sentry transport");
let finishFlush: () => void = () => {
  throw new Error("Sentry flush release was not initialized");
};
const flushReleased = new Promise<boolean>((resolve) => {
  finishFlush = () => resolve(true);
});
transport.send = async () => {
  process.send?.("fatal_captured");
  return { statusCode: 200 };
};
transport.flush = async () => flushReleased;

let releaseHttpResponse: () => void = () => {
  throw new Error("HTTP response release was not initialized");
};
const responseReleased = new Promise<void>((resolve) => {
  releaseHttpResponse = resolve;
});
process.on("message", (message) => {
  if (message === "release_http") releaseHttpResponse();
  if (message === "release_flush") finishFlush();
});
const server = setupServer(
  http.get(
    "https://www.mountainproject.com/user/110186720/ticks/tick-export",
    () => new HttpResponse(input.csv),
  ),
  http.get("https://www.mountainproject.com/api/v2/routes/:id", ({ params }) =>
    HttpResponse.json({
      id: Number(params.id),
      title: "Route",
      parent: { id: 2, name: "Crag" },
    }),
  ),
  http.get("https://www.mountainproject.com/api/v2/areas/2", async () => {
    process.send?.("http_pending");
    await responseReleased;
    return HttpResponse.json({
      id: 2,
      title: "Old disconnected crag",
      parent: { id: 0, name: "" },
      coordinates: [-105, 39],
    });
  }),
);
server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
const database = createDatabase(input.connectionString);
const workLockPool = createAccountErasureWorkLockPool(input.connectionString);
try {
  await runQueuedUserWorkUnlessAccountErasing(
    workLockPool,
    database,
    input.userId,
    "provider lock disconnect fixture",
    async () => {
      await new MountainProjectProvider().sync(
        new SyncRun({
          db: database,
          userId: input.userId,
          window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")),
        }),
      );
      process.send?.("callback_finished");
    },
    "mountain-project",
  );
} catch (error) {
  Sentry.captureException(error);
  process.send?.("guard_failed");
} finally {
  server.close();
  await workLockPool.close();
  await database.$client.end();
}
